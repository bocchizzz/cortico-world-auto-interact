/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { AUTO_INTERACT } from './definition.ts';

export default AUTO_INTERACT;
export { AUTO_INTERACT };
export type { AutoInteractConfigSection } from './config.ts';
