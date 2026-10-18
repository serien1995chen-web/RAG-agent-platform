import { useSyncExternalStore } from 'react';
import { snapshot, subscribe, type DemoState } from './run-store';

/** 首屏无 sessionStorage：必须是稳定引用，否则 useSyncExternalStore 会无限重渲染。 */
const EMPTY_STATE: DemoState = { runs: [], defects: [], scenarios: [], createdIds: [] };

/** 订阅会话证据链（Run Spine / 缺陷 / 场景共用）。 */
export function useDemoStore() {
  return useSyncExternalStore(
    subscribe,
    snapshot,
    () => EMPTY_STATE,
  );
}
