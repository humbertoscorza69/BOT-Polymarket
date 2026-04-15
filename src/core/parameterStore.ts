/**
 * Compatibility shim: the persistent ParamsStore lives under `persistence/paramsStore`.
 * This module just re-exports it for the originally-specified path.
 */
export { ParamsStore, defaultAdaptiveParams, AdaptiveParams } from '../persistence/paramsStore';
