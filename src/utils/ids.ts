import { v4 as uuidv4 } from 'uuid';

export const newId = (prefix?: string): string => {
  const id = uuidv4();
  return prefix ? `${prefix}_${id.slice(0, 8)}` : id;
};

export const newRunId = (): string => `run_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

export const newQuoteId = (): string => newId('q');

export const newOrderId = (): string => newId('o');

export const newFillId = (): string => newId('f');
