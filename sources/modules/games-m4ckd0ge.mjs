import { createGameSource } from './games-core.mjs';
let api;
export function setup(runtime, config) { api = createGameSource('m4ckd0ge', runtime, config); }
const ready = () => api || (api = createGameSource('m4ckd0ge'));
export const catalog = options => ready().catalog(options);
export const search = (query, options) => ready().search(query, options);
export const detail = id => ready().detail(id);
export const resolve = request => ready().resolve(request);
