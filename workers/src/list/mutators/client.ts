/**
 * Re-export shim for the pages app, which imports `mutators` from
 * `$djibb/list/mutators/client`. The actual mutator definitions live
 * in per-mutator files alongside their server counterparts (see
 * `./initList.ts`, `./createListItem.ts`, etc.) and are assembled in
 * `./index.ts`.
 */
export { mutators, Mutations } from './index';
export { wireArgsSchema as initListArgsSchema } from './initList';
export { DEFAULT_LIST_TITLE } from './index';
export { FRICTION_TIER_MUTATORS, isFrictionTier } from './_shared';
export type {
    CapturePreState,
    Inverse,
    MutatorModule,
    PreState,
} from './_shared';
