import EventEmitter from 'eventemitter3';
import { BotConfig } from '../config';
import {
  InventoryState,
  RiskEvent,
  RiskState,
} from '../types';
import { getLogger } from '../utils/logger';

const log = getLogger('risk');

export interface RiskInputs {
  sessionPnl: number;
  peakPnl: number;
  consecutiveLosses: number;
  adverseSelectionEma: number;
  apiErrors: number;
  feedStale: boolean;
  orderRejections: number;
  reconcileDrift: boolean;
  inventory: InventoryState;
  totalFills: number;
}

export class RiskManager extends EventEmitter {
  private state: RiskState = 'NORMAL';
  private events: RiskEvent[] = [];
  private lastTransition = Date.now();

  // Fix 1: Balance-based kill switch — independent of PnL/fill accounting
  private startBalance: number | null = null;
  private sessionPeakBalance: number | null = null;

  // Fix 4: Consecutive RECONCILE_DRIFT HALT counter
  private consecutiveDriftHalts = 0;
  private terminalKill = false;

  constructor(private readonly cfg: BotConfig) {
    super();
  }

  getState(): RiskState {
    return this.state;
  }

  getEvents(): RiskEvent[] {
    return this.events.slice(-50);
  }

  evaluate(inp: RiskInputs): RiskState {
    const drawdown = Math.max(0, inp.peakPnl - inp.sessionPnl);
    const prev = this.state;

    let next: RiskState = 'NORMAL';
    let reason = '';
    let code = 'OK';

    if (inp.reconcileDrift) {
      next = 'HALTED';
      reason = 'reconciliation drift detected';
      code = 'RECONCILE_DRIFT';
    } else if (inp.apiErrors > this.cfg.riskApiErrorCap) {
      next = 'HALTED';
      reason = 'API error cap exceeded';
      code = 'API_ERRORS';
    } else if (inp.sessionPnl <= -this.cfg.riskSessionLossCapUsdc) {
      next = 'EMERGENCY';
      reason = `session loss cap ${inp.sessionPnl.toFixed(2)}`;
      code = 'SESSION_LOSS';
    } else if (drawdown >= this.cfg.riskDrawdownCapUsdc) {
      next = 'HALTED';
      reason = `drawdown ${drawdown.toFixed(2)}`;
      code = 'DRAWDOWN';
    } else if (inp.consecutiveLosses >= this.cfg.riskConsecutiveLossCap) {
      next = 'THROTTLED';
      reason = `consecutive losses ${inp.consecutiveLosses}`;
      code = 'CONSEC_LOSS';
    } else if (inp.totalFills >= 3 && inp.adverseSelectionEma >= this.cfg.riskToxicFlowEmaCap) {
      next = 'HALTED';
      reason = `toxic flow ema ${inp.adverseSelectionEma.toFixed(2)}`;
      code = 'TOXIC_FLOW';
    } else if (inp.totalFills >= 3 && inp.adverseSelectionEma >= this.cfg.riskToxicFlowEmaCap * 0.75) {
      next = 'THROTTLED';
      reason = `elevated toxicity ${inp.adverseSelectionEma.toFixed(2)}`;
      code = 'ELEVATED_TOX';
    } else if (inp.orderRejections > 10) {
      next = 'THROTTLED';
      reason = `order rejections ${inp.orderRejections}`;
      code = 'REJECTIONS';
    } else if (Math.abs(inp.inventory.normalizedSkew) > 0.95) {
      next = 'THROTTLED';
      reason = `inventory extreme skew ${inp.inventory.normalizedSkew.toFixed(2)}`;
      code = 'INV_EXTREME';
    } else if (inp.feedStale) {
      next = 'THROTTLED';
      reason = 'feed stale';
      code = 'FEED_STALE';
    }

    // don't demote from EMERGENCY automatically
    if (prev === 'EMERGENCY') next = 'EMERGENCY';
    // don't oscillate too fast: if we went HALTED, require at least 5s
    if (prev === 'HALTED' && Date.now() - this.lastTransition < 5000 && next === 'NORMAL') {
      next = 'THROTTLED';
    }

    if (next !== prev) {
      const severity: RiskEvent['severity'] =
        next === 'EMERGENCY' ? 'error' : next === 'HALTED' ? 'error' : next === 'THROTTLED' ? 'warn' : 'info';
      const ev: RiskEvent = {
        ts: Date.now(),
        state: next,
        reason,
        code,
        severity,
        pnl: inp.sessionPnl,
        drawdown,
      };
      this.events.push(ev);
      if (this.events.length > 200) this.events.shift();
      this.state = next;
      this.lastTransition = Date.now();
      log.warn('risk state change', { from: prev, to: next, reason, code });
      this.emit('transition', ev);
    }
    return this.state;
  }

  /**
   * Fix 1: Balance-based kill switch.
   * Called every tick with the current exchange USDC balance.
   * Compares against startBalance (recorded on first call) and sessionPeak.
   * Returns true if a kill condition is met.
   */
  checkBalanceKill(currentBalance: number): boolean {
    if (this.terminalKill) return true;

    if (this.startBalance === null) {
      this.startBalance = currentBalance;
      this.sessionPeakBalance = currentBalance;
      log.info('[BALANCE-KILL] start balance recorded', { startBalance: currentBalance });
      return false;
    }

    if (currentBalance > this.sessionPeakBalance!) {
      this.sessionPeakBalance = currentBalance;
    }

    const sessionLoss = this.startBalance - currentBalance;
    const drawdownFromPeak = this.sessionPeakBalance! - currentBalance;

    if (sessionLoss > this.cfg.riskSessionLossCapUsdc) {
      const reason = `balance kill: session loss $${sessionLoss.toFixed(2)} > cap $${this.cfg.riskSessionLossCapUsdc}`;
      log.error('[BALANCE-KILL] ' + reason, {
        startBalance: this.startBalance,
        currentBalance,
        sessionLoss,
        cap: this.cfg.riskSessionLossCapUsdc,
      });
      this.terminalKill = true;
      this.forceState('EMERGENCY', reason);
      return true;
    }

    if (drawdownFromPeak > this.cfg.riskDrawdownCapUsdc) {
      const reason = `balance kill: drawdown $${drawdownFromPeak.toFixed(2)} > cap $${this.cfg.riskDrawdownCapUsdc}`;
      log.error('[BALANCE-KILL] ' + reason, {
        peak: this.sessionPeakBalance,
        currentBalance,
        drawdown: drawdownFromPeak,
        cap: this.cfg.riskDrawdownCapUsdc,
      });
      this.terminalKill = true;
      this.forceState('EMERGENCY', reason);
      return true;
    }

    return false;
  }

  /** Fix 4: Track consecutive RECONCILE_DRIFT HALTs. Returns true if terminal. */
  trackDriftHalt(isDriftHalt: boolean): boolean {
    if (this.terminalKill) return true;

    if (isDriftHalt) {
      this.consecutiveDriftHalts++;
      log.warn('[DRIFT-HALT] consecutive drift halt', { count: this.consecutiveDriftHalts });
      if (this.consecutiveDriftHalts >= 3) {
        const reason = `terminal: ${this.consecutiveDriftHalts} consecutive RECONCILE_DRIFT HALTs`;
        log.error('[DRIFT-HALT] ' + reason);
        this.terminalKill = true;
        this.forceState('EMERGENCY', reason);
        return true;
      }
    } else {
      this.consecutiveDriftHalts = 0;
    }
    return false;
  }

  isTerminal(): boolean {
    return this.terminalKill;
  }

  forceState(state: RiskState, reason: string): void {
    if (this.state === state) return;
    const ev: RiskEvent = {
      ts: Date.now(),
      state,
      reason,
      code: 'FORCED',
      severity: 'warn',
    };
    this.state = state;
    this.lastTransition = Date.now();
    this.events.push(ev);
    this.emit('transition', ev);
  }
}
