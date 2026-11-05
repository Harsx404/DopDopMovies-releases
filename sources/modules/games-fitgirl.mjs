import { createGameSource } from './games-core.mjs';
let api;
export function setup(runtime, config) { api = createGameSource('fitgirl', runtime, config); }
const ready = () => api || (api = createGameSource('fitgirl'));
export const catalog = options => ready().catalog(options);
export const search = (query, options) => ready().search(query, options);
export const detail = id => ready().detail(id);
export const resolve = request => ready().resolve(request);
