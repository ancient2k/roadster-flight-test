// Run AFTER Blender generation and compression. Decodes meshopt before measuring.
// Writes measured facts only; fails on missing assets or any contract violation.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const dir=path.join(root,'public/assets/worlds/earth_bocachica');
await MeshoptDecoder.ready;
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
const results=[];
for(const file of ['starbase.glb','tower_a.glb','tower_a_lod1.glb','tower_b.glb','tower_b_lod1.glb','starship_stack.glb','starship_stack_lod1.glb']) {
  const doc=await io.read(path.join(dir,file)),r=doc.getRoot(),nodes=r.listNodes();
  const get=n=>{const matches=nodes.filter(x=>x.getName()===n);assert.equal(matches.length,1,`${file}: unique ${n}`);return matches[0];};
  const child=(a,b)=>assert(get(a).listChildren().includes(get(b)),`${file}: ${a} > ${b}`);
  const rootName=file.startsWith('tower')?'Tower':file.startsWith('starship')?'Stack':'Starbase';
  assert.deepEqual(r.listScenes()[0].listChildren().map(n=>n.getName()),[rootName]);
  assert.deepEqual(get(rootName).getTranslation(),[0,0,0]);
  assert.deepEqual(get(rootName).getScale(),[1,1,1]);
  if(rootName==='Tower') {
    child('Tower','Carriage');
    for(const n of ['Arm_L','Arm_R','QD_Arm','CatchPoint','Hinge_L','Hinge_R'])child('Carriage',n);
    for(const side of ['L','R'])assert.deepEqual(get('Arm_'+side).getTranslation(),get('Hinge_'+side).getTranslation());
    assert.equal(get('Carriage').getTranslation()[1],84);
    for(const n of ['CatchPoint','Hinge_L','Hinge_R'])assert.equal(get(n).getMesh(),null);
  }
  if(rootName==='Stack') {
    child('Stack','SuperHeavy');child('Stack','Starship');child('SuperHeavy','HotStageRing');child('SuperHeavy','CatchPins');
    for(let i=0;i<4;i++)child('SuperHeavy',`GridFin_${i}`);
    for(let i=0;i<33;i++)child('SuperHeavy',`Engine_${String(i).padStart(2,'0')}`);
    for(const n of ['FL','FR','AL','AR'])child('Starship',`Flap_${n}`);
    for(let i=0;i<3;i++)for(const s of ['SL','RVac'])child('Starship',`Engine_${s}_${i}`);
    child('SuperHeavy','PlumeOrigin_SH');child('Starship','PlumeOrigin_SS');
    assert.deepEqual(get('Starship').getTranslation(),[0,72,0]);
    assert.equal(get('HotStageRing').getTranslation()[1],70);
    const meshes=n=>{const out=new Set();n.traverse(o=>{if(o.getMesh())out.add(o.getMesh());});return out;};
    const booster=meshes(get('SuperHeavy')),ship=meshes(get('Starship'));
    assert(![...booster].some(m=>ship.has(m)), 'No shared meshes between stages');
  }
  let tris=0;const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const n of nodes) {
    assert.deepEqual(n.getScale(),[1,1,1],`${file} applied scale ${n.getName()}`);
    const matrix=n.getWorldMatrix();
    for(const p of n.getMesh()?.listPrimitives()??[]) {
      assert.equal(p.getMode(),4);
      tris+=(p.getIndices()?.getCount()??p.getAttribute('POSITION').getCount())/3;
      const pos=p.getAttribute('POSITION');
      for(let i=0;i<pos.getCount();i++) {
        const v=pos.getElement(i,[]);
        for(let k=0;k<3;k++) {const x=matrix[k]*v[0]+matrix[4+k]*v[1]+matrix[8+k]*v[2]+matrix[12+k];assert(Number.isFinite(x));min[k]=Math.min(min[k],x);max[k]=Math.max(max[k],x);}
      }
    }
  }
  const bytes=fs.statSync(path.join(dir,file)).size;
  assert(bytes<=(rootName==='Starbase'?6:rootName==='Tower'?2.5:4)*1e6,`${file} bytes budget`);
  assert(tris<=(rootName==='Starbase'?600000:rootName==='Tower'?250000:300000),`${file} triangle budget`);
  if(rootName==='Starbase')assert(r.listMaterials().length<=12);
  if(rootName==='Stack'){assert(Math.abs(min[1])<.001);assert(Math.abs(max[1]-124)<.001);}
  for(const t of r.listTextures()){const size=t.getSize();assert(size&&size.every(n=>n<=1024));}
  results.push({file,bytes,triangles:tris,materials:r.listMaterials().length,textures:r.listTextures().length,bounds:{min,max}});
}
for(const r of results.filter(x=>x.file.includes('_lod1'))) {
  const base=results.find(x=>x.file===r.file.replace('_lod1',''));r.triangleRatio=r.triangles/base.triangles;
  assert(r.triangleRatio>=.18&&r.triangleRatio<=.32,`${r.file} LOD ratio`);
}
fs.writeFileSync(path.join(dir,'asset_metrics.json'),JSON.stringify(results,null,2)+'\n');
console.table(results.map(({bounds,...rest})=>rest));
