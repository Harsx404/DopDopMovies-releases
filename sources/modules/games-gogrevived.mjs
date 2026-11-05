import { createGameSource } from './games-core.mjs';
let api;
export function setup(runtime, config) { api = createGameSource('gogrevived', runtime, config); }
const ready = () => api || (api = createGameSource('gogrevived'));
export const catalog = options => ready().catalog(options);
export const search = (query, options) => ready().search(query, options);
export const detail = id => ready().detail(id);
export const resolve = request => ready().resolve(request);
