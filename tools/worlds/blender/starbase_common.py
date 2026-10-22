"""Procedural Starbase mesh batches. Author ENU (east,north,up); glTF = (E,U,-N).
No external geometry/images. Like common.py, export_yup performs the frame conversion.
"""
import math, json, os
from pathlib import Path
import bpy, bmesh
import numpy as np
from mathutils import Vector
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'public/assets/worlds/earth_bocachica'
RENDERS = ROOT / 'out/renders/starbase'

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    OUT.mkdir(parents=True, exist_ok=True)

def empty(name, parent=None, pos=(0,0,0)):
    o=bpy.data.objects.new(name,None); bpy.context.collection.objects.link(o)
    o.parent=parent; o.location=pos
    return o

def materials():
    specs=[('Steel',(.55,.59,.62),.92,.32),('White',(.82,.84,.82),.18,.42),
           ('DarkSteel',(.09,.12,.14),.8,.43),('Concrete',(.46,.45,.40),0,.82),
           ('Asphalt',(.10,.12,.13),0,.9),('Sand',(.49,.43,.31),0,.94),
           ('Tiles',(.022,.027,.032),.05,.84),('Engine',(.15,.18,.21),.95,.26)]
    mats=[]
    for name,col,metal,rough in specs:
        m=bpy.data.materials.new(name); m.use_nodes=True
        p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*col,1)
        p.inputs['Metallic'].default_value=metal; p.inputs['Roughness'].default_value=rough
        m.diffuse_color=(*col,1); mats.append(m)
    # Periodic hex Voronoi: two offset triangular sublattices in a rectangular repeat.
    n=512; y,x=np.mgrid[0:n,0:n]/n
    ds=[]
    for row in range(-2,4):
        for column in range(-2,4):
            ds.append((x-column-(row%2)*.5)**2+((y-row*.5)*math.sqrt(3))**2)
    dd=np.partition(np.stack(ds),1,axis=0)
    tile=np.clip((np.sqrt(dd[1])-np.sqrt(dd[0]))*45,0,1)
    steel=1-.18*(np.minimum(x,1-x)<.008)-.13*(np.minimum(y,1-y)<.007)
    steel+=.012*np.sin(y*math.tau*140)
    for mi,field,base in [(0,steel,(.55,.59,.62)),(6,tile,(.028,.033,.04))]:
        for kind in ['color','normal']:
            rgba=np.ones((n,n,4),np.float32)
            if kind=='color': rgba[:,:,:3]=np.array(base)*(0.55+field[:,:,None]*.45)
            else:
                gx=(np.roll(field,-1,1)-np.roll(field,1,1))*.45
                gy=(np.roll(field,-1,0)-np.roll(field,1,0))*.45
                v=np.stack([-gx,-gy,np.ones_like(gx)],-1); v/=np.linalg.norm(v,axis=-1,keepdims=True)
                rgba[:,:,:3]=v*.5+.5
            im=bpy.data.images.new(f'{mats[mi].name}_{kind}',width=n,height=n,alpha=False)
            if kind=='normal': im.colorspace_settings.name='Non-Color'
            im.pixels.foreach_set(rgba.ravel()); im.pack()
            nt=mats[mi].node_tree; tex=nt.nodes.new('ShaderNodeTexImage'); tex.image=im
            p=nt.nodes.get('Principled BSDF')
            if kind=='color': nt.links.new(tex.outputs['Color'],p.inputs['Base Color'])
            else:
                nm=nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(tex.outputs['Color'],nm.inputs['Color']); nt.links.new(nm.outputs['Normal'],p.inputs['Normal'])
    return mats

class Mesh:
    def __init__(self): self.v=[]; self.f=[]; self.m=[]; self.uv=[]; self.s=[]
    def face(self,pts,mat=0,uv=None,smooth=False):
        k=len(self.v); self.v.extend(pts); self.f.append(tuple(range(k,k+len(pts)))); self.m.append(mat); self.s.append(smooth)
        if uv is None:
            a,b,c=map(Vector,pts[:3]); normal=(b-a).cross(c-a); ax=max(range(3),key=lambda i:abs(normal[i])); axes=[i for i in range(3) if i!=ax]
            uv=[(p[axes[0]],p[axes[1]]) for p in pts]
        self.uv.extend(uv)
    def box(self,c,size,mat=0):
        x,y,z=c; a,b,h=[v/2 for v in size]
        v=[(x+sx*a,y+sy*b,z+sz*h) for sx,sy,sz in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
        for ids in [(3,2,1,0),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]: self.face([v[i] for i in ids],mat)
    def beam(self,a,b,w=.2,mat=0,depth=None):
        a,b=Vector(a),Vector(b); d=(b-a).normalized(); ref=Vector((0,0,1)) if abs(d.z)<.9 else Vector((0,1,0)); u=d.cross(ref).normalized()*w/2; v=d.cross(u).normalized()*(depth or w)/2
        p=[q+u*s+v*t for q in (a,b) for s,t in [(-1,-1),(1,-1),(1,1),(-1,1)]]
        for ids in [(3,2,1,0),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]: self.face([p[i] for i in ids],mat)
    def pipe(self,a,b,r=.22,mat=0,n=12):
        a,b=Vector(a),Vector(b); d=b-a
        if d.length < 1e-6:return
        rotation=Vector((0,0,1)).rotation_difference(d.normalized())
        tmp=Mesh();tmp.cylinder((0,0,0),r,d.length,mat,n)
        for face,material,smooth in zip(tmp.f,tmp.m,tmp.s):
            self.face([a+rotation@Vector(tmp.v[i]) for i in face],material,smooth=smooth)
    def lathe(self,c,profile,mat=0,n=64,half=False):
        # Profile is (radius,height); hollow shells/rings are closed by profile itself.
        for j in range(len(profile)-1):
            r,z=profile[j]; r2,z2=profile[j+1]
            for i in range(n):
                a=i*math.tau/n; b=(i+1)*math.tau/n
                pts=[(c[0]+rr*math.cos(t),c[1]+rr*math.sin(t),c[2]+zz) for rr,zz,t in [(r,z,a),(r,z,b),(r2,z2,b),(r2,z2,a)]]
                # Windward = north / glTF -Z. Half circumference, never full wrap.
                m=6 if half and math.sin((a+b)/2)>0 else mat
                scale=.32 if m==6 else 1.8
                uv=[(t*4.5/scale,zz/(scale*math.sqrt(3))) for rr,zz,t in [(r,z,a),(r,z,b),(r2,z2,b),(r2,z2,a)]]
                self.face(pts,m,uv,True)
    def ring(self,c,r,inner,h,mat=0,n=64):
        self.lathe(c,[(inner,0),(r,0),(r,h),(inner,h),(inner,0)],mat,n)
    def cylinder(self,c,r,h,mat=0,n=48): self.lathe(c,[(0,0),(r,0),(r,h),(0,h)],mat,n)
    def prism(self,points,z,h,mat=3):
        p=list(points)
        if p[0]==p[-1]: p=p[:-1]
        if len(p)<3:return
        area=sum(p[i][0]*p[(i+1)%len(p)][1]-p[(i+1)%len(p)][0]*p[i][1] for i in range(len(p)))
        if area<0:p.reverse()
        self.face([(x,y,z+h) for x,y in p],mat);self.face([(x,y,z) for x,y in p[::-1]],mat)
        for a,b in zip(p,p[1:]+p[:1]):self.face([(a[0],a[1],z),(b[0],b[1],z),(b[0],b[1],z+h),(a[0],a[1],z+h)],mat)
    def object(self,name,mats,parent=None,pos=(0,0,0)):
        me=bpy.data.meshes.new(name); me.from_pydata(self.v,[],self.f); me.update()
        for m in mats: me.materials.append(m)
        uv=me.uv_layers.new()
        for p,m,s in zip(me.polygons,self.m,self.s):p.material_index=m;p.use_smooth=s
        for i,v in enumerate(self.uv):uv.data[i].uv=v
        # Weld repeated beam/profile vertices while preserving UV seams and flat/smooth boundaries.
        bm=bmesh.new();bm.from_mesh(me);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bmesh.ops.triangulate(bm,faces=list(bm.faces));bm.to_mesh(me);bm.free()
        ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob);ob.parent=parent;ob.location=pos
        return ob

def export(name,lod=False):
    objs=[o for o in bpy.context.scene.objects if o.type=='MESH']
    if lod:
        for ob in objs:
            bpy.context.view_layer.objects.active=ob
            mod=ob.modifiers.new('LOD1','DECIMATE'); mod.ratio=.25
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.context.scene.objects:
        if o.type in ('MESH','EMPTY'):o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_texcoords=True,export_normals=True,export_materials='EXPORT',export_extras=True)
    return sum(len(o.data.polygons) for o in objs)

def render(filename,eye,target,ortho):
    RENDERS.mkdir(parents=True,exist_ok=True)
    sc=bpy.context.scene;sc.render.engine='CYCLES';sc.cycles.samples=24;sc.cycles.use_denoising=True
    sc.render.resolution_x=1600;sc.render.resolution_y=900;sc.render.resolution_percentage=100
    sc.world=bpy.data.worlds.new('Daylight') if sc.world is None else sc.world;sc.world.use_nodes=True;sc.world.node_tree.nodes['Background'].inputs[0].default_value=(.55,.69,.85,1);sc.world.node_tree.nodes['Background'].inputs[1].default_value=.5
    sun=bpy.data.objects.get('PreviewSun')
    if not sun:
        ld=bpy.data.lights.new('PreviewSun','SUN');ld.energy=3;ld.angle=.12;sun=bpy.data.objects.new('PreviewSun',ld);bpy.context.collection.objects.link(sun);sun.rotation_euler=(.4,-.5,-.5)
    cam=bpy.data.objects.get('PreviewCamera')
    if not cam:
        cd=bpy.data.cameras.new('PreviewCamera');cam=bpy.data.objects.new('PreviewCamera',cd);bpy.context.collection.objects.link(cam)
    cam.location=eye;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=ortho;cam.data.clip_end=10000;sc.camera=cam
    sc.view_settings.view_transform='AgX';sc.render.image_settings.file_format='PNG';sc.render.filepath=str(RENDERS/filename);bpy.ops.render.render(write_still=True)

def ground(mats,center=(0,0,-.3),size=(600,600,.3)):
    m=Mesh();m.box(center,size,5);return m.object('PreviewGround',mats)
