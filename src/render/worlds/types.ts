// Uniform node types (the @types/three generics are strict; derive them from factory functions).
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

const _f = () => uniform(0);
const _v3 = () => uniform(new THREE.Vector3());
const _c = () => uniform(new THREE.Color());
export type UFloat = ReturnType<typeof _f>;
export type UVec3 = ReturnType<typeof _v3>;
export type UColor = ReturnType<typeof _c>;
