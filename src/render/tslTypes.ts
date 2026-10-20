// Small type helpers for TSL nodes (the @types/three generics are very strict).
import { uniform } from 'three/tsl';

const _uf = () => uniform(0);
const _uc = () => uniform(new (class { r = 0; g = 0; b = 0; })() as never);
/** Float uniform node type. */
export type UFloat = ReturnType<typeof _uf>;
export type UAny = ReturnType<typeof _uc>;
