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

# A repeat contains 4 staggered rows and 4 columns of 0.30 m hexagons.
TILE_U = 1.2
TILE_V = .6 * math.sqrt(3)


def materials():
    specs=[('Steel',(.75,.74,.72),1.,.30),('White',(.84,.83,.79),0.,.50),
           ('DarkSteel',(.16,.165,.17),.15,.60),('Concrete',(.46,.45,.40),0,.82),
           ('Asphalt',(.10,.12,.13),0,.9),('Sand',(.49,.43,.31),0,.94),
           ('Tiles',(.065,.067,.069),0.,.82),('Engine',(.29,.28,.26),1.,.28)]
    mats=[]
    for name,col,metal,rough in specs:
        m=bpy.data.materials.new(name); m.use_nodes=True
        p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*col,1)
        p.inputs['Metallic'].default_value=metal; p.inputs['Roughness'].default_value=rough
        m.diffuse_color=(*col,1); mats.append(m)
    n=512; v,u=np.mgrid[0:n,0:n]/n
    # Periodic nearest/second-nearest hex centre distances, in physical metres.
    xx,yy=u*TILE_U,v*TILE_V
    d1=np.full((n,n),1e9);d2=d1.copy();variation=np.zeros_like(d1)
    for row in range(-2,7):
        for col in range(-2,7):
            d=(xx-(col+.5*(row%2))*.3)**2+(yy-row*.15*math.sqrt(3))**2
            closer=d<d1
            d2=np.where(closer,d1,np.minimum(d2,d));d1=np.minimum(d1,d)
            tone=((col%4)*13+(row%4)*7+((col%4)*(row%4))*3)%17/16
            variation=np.where(closer,tone,variation)
    edge=np.clip((d2-d1)/(.6*.004),0,1)
    tile_height=.0012*edge
    tile_color=(.022+edge*(.033+.025*variation))[:,:,None]*np.array([.98,1.,1.02])
    # Steel UV repeats every 1.8 m vertically; ring seams and gentle axial streaks.
    seam=np.exp(-(np.minimum(v,1-v)/.0028)**2)
    streak=.012*np.sin(u*math.tau*23)+.007*np.sin(u*math.tau*71+v*2)
    steel_height=-.0003*seam+.000015*np.sin(u*math.tau*71)
    steel_color=(1-.055*seam+streak)[:,:,None]*np.array([.75,.74,.72])
    for mi,height,col,physical,rough in [
        (0,steel_height,steel_color,(1.8,1.8),np.clip(.28+.065*seam-streak,.25,.35)),
        (6,tile_height,tile_color,(TILE_U,TILE_V),.77+.1*variation)]:
        gx=(np.roll(height,-1,1)-np.roll(height,1,1))*n/(2*physical[0])
        gy=(np.roll(height,-1,0)-np.roll(height,1,0))*n/(2*physical[1])
        normal=np.stack([-gx,-gy,np.ones_like(gx)],-1)
        normal/=np.linalg.norm(normal,axis=-1,keepdims=True)
        for kind in ['color','normal','roughness']:
            rgba=np.ones((n,n,4),np.float32)
            rgba[:,:,:3]=col if kind=='color' else normal*.5+.5 if kind=='normal' else rough[:,:,None]
            im=bpy.data.images.new(f'{mats[mi].name}_{kind}',width=n,height=n,alpha=False)
            # Blender image pixel values are linear. Keep data maps untransformed.
            if kind!='color':im.colorspace_settings.name='Non-Color'
            im.pixels.foreach_set(np.ascontiguousarray(rgba).ravel());im.pack()
            nt=mats[mi].node_tree;tex=nt.nodes.new('ShaderNodeTexImage');tex.image=im
            p=nt.nodes.get('Principled BSDF')
            if kind=='normal':
                nm=nt.nodes.new('ShaderNodeNormalMap')
                nt.links.new(tex.outputs['Color'],nm.inputs['Color']);nt.links.new(nm.outputs['Normal'],p.inputs['Normal'])
            else:
                nt.links.new(tex.outputs['Color'],p.inputs['Base Color' if kind=='color' else 'Roughness'])
                if kind=='roughness':p.inputs['Roughness'].default_value=1.
    return mats


def clean_mesh(me):
    """Repair topology before export, retaining UV/material CustomData.

    Validate once before BMesh and once after topology changes. A second validation
    must be a no-op, and every polygon/loop/edge index is checked explicitly.
    """
    me.validate(verbose=True, clean_customdata=False)
    bm=bmesh.new();bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-6)
    bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=1e-7)
    seen=set();bad=[]
    for f in bm.faces:
        key=frozenset(f.verts)
        if len(key)<3 or f.calc_area()<1e-10 or key in seen:bad.append(f)
        else:seen.add(key)
    if bad:bmesh.ops.delete(bm,geom=bad,context='FACES_ONLY')
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    bad=[f for f in bm.faces if f.calc_area()<1e-10]
    if bad:bmesh.ops.delete(bm,geom=bad,context='FACES_ONLY')
    loose=[v for v in bm.verts if not v.link_faces]
    if loose:bmesh.ops.delete(bm,geom=loose,context='VERTS')
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(me);bm.free()
    me.update(calc_edges=True,calc_edges_loose=True)
    me.validate(verbose=True,clean_customdata=False)
    me.update(calc_edges=True,calc_edges_loose=True)
    if me.validate(verbose=True,clean_customdata=False):
        raise RuntimeError(f'{me.name}: mesh validation did not converge')
    nv,nl,ne=len(me.vertices),len(me.loops),len(me.edges)
    assert all(0<=i<nv for e in me.edges for i in e.vertices),me.name
    assert all(0<=l.vertex_index<nv and 0<=l.edge_index<ne for l in me.loops),me.name
    assert all(0<=i<nl for p in me.polygons for i in p.loop_indices),me.name
    assert all(len(p.vertices)==3 and p.area>1e-10 for p in me.polygons),me.name
    me.calc_loop_triangles()
    assert all(0<=i<nv for t in me.loop_triangles for i in t.vertices),me.name


class Mesh:
    def __init__(self): self.v=[]; self.f=[]; self.m=[]; self.uv=[]; self.s=[]
    def face(self,pts,mat=0,uv=None,smooth=False):
        pts=[tuple(float(x) for x in p) for p in pts]
        assert all(len(p)==3 and all(math.isfinite(x) for x in p) for p in pts)
        if uv is not None:assert len(uv)==len(pts)
        # Collapsed lathe poles become triangles, never quads with coincident corners.
        keep=[]
        for i,p in enumerate(pts):
            if not any(sum((a-b)**2 for a,b in zip(p,pts[j]))<1e-16 for j in keep):keep.append(i)
        pts=[pts[i] for i in keep]
        if uv is not None:uv=[uv[i] for i in keep]
        if len(pts)<3:return
        area=Vector((0,0,0))
        origin=Vector(pts[0])
        for a,b in zip(pts[1:-1],pts[2:]):area+=(Vector(a)-origin).cross(Vector(b)-origin)
        if area.length<1e-10:return
        if uv is None:
            ax=max(range(3),key=lambda i:abs(area[i]));axes=[i for i in range(3) if i!=ax]
            sx,sy=(TILE_U,TILE_V) if mat==6 else (1.8,1.8)
            uv=[(p[axes[0]]/sx,p[axes[1]]/sy) for p in pts]
        k=len(self.v);self.v.extend(pts);self.f.append(tuple(range(k,k+len(pts))))
        self.m.append(mat);self.s.append(smooth);self.uv.extend(uv)
    def box(self,c,size,mat=0):
        x,y,z=c; a,b,h=[v/2 for v in size]
        v=[(x+sx*a,y+sy*b,z+sz*h) for sx,sy,sz in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
        for ids in [(3,2,1,0),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]: self.face([v[i] for i in ids],mat)
    def beam(self,a,b,w=.2,mat=0,depth=None):
        a,b=Vector(a),Vector(b)
        if (b-a).length<1e-8:return
        d=(b-a).normalized(); ref=Vector((0,0,1)) if abs(d.z)<.9 else Vector((0,1,0)); u=d.cross(ref).normalized()*w/2; v=d.cross(u).normalized()*(depth or w)/2
        p=[q+u*s+v*t for q in (a,b) for s,t in [(-1,-1),(1,-1),(1,1),(-1,1)]]
        for ids in [(3,2,1,0),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]: self.face([p[i] for i in ids],mat)
    def girder(self,a,b,width=.45,depth=.7,mat=2,thickness=.065):
        a,b=Vector(a),Vector(b);d=b-a
        if d.length<1e-8:return
        d.normalize();ref=Vector((0,0,1)) if abs(d.z)<.9 else Vector((0,1,0))
        u=d.cross(ref).normalized();v=d.cross(u).normalized()
        self.beam(a,b,thickness,mat,depth)
        for sign in [-1,1]:
            shift=v*sign*(depth-thickness)/2
            self.beam(a+shift,b+shift,width,mat,thickness)
    def path(self,pts,r=.06,mat=0,n=12):
        for a,b in zip(pts,pts[1:]):self.pipe(a,b,r,mat,n)
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
                sx,sy=(TILE_U,TILE_V) if m==6 else (1.8,1.8)
                uv=[(t*4.5/sx,zz/sy) for rr,zz,t in [(r,z,a),(r,z,b),(r2,z2,b),(r2,z2,a)]]
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
        assert len(self.f)==len(self.m)==len(self.s),name
        assert len(self.uv)==sum(len(f) for f in self.f),name
        assert all(0<=i<len(self.v) for f in self.f for i in f),name
        me=bpy.data.meshes.new(name); me.from_pydata(self.v,[],self.f); me.update()
        for m in mats: me.materials.append(m)
        uv=me.uv_layers.new()
        for p,m,s in zip(me.polygons,self.m,self.s):p.material_index=m;p.use_smooth=s
        for i,v in enumerate(self.uv):uv.data[i].uv=v
        assert all(0<=i<len(self.v) for f in self.f for i in f),name
        clean_mesh(me)
        ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob);ob.parent=parent;ob.location=pos
        return ob

def export(name,lod=False):
    objs=[o for o in bpy.context.scene.objects if o.type=='MESH']
    if lod:
        for ob in objs:
            bpy.context.view_layer.objects.active=ob
            mod=ob.modifiers.new('LOD1','DECIMATE'); mod.ratio=.25
            bpy.ops.object.modifier_apply(modifier=mod.name)
    for ob in objs:clean_mesh(ob.data)
    triangles=sum(len(ob.data.loop_triangles) for ob in objs)
    print(f'[starbase] {name}: {triangles:,} validated triangles; {len(objs)} meshes')
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.context.scene.objects:
        if o.type in ('MESH','EMPTY'):o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_texcoords=True,export_normals=True,export_materials='EXPORT',export_extras=True)
    return sum(len(o.data.polygons) for o in objs)

def render(filename,eye,target,ortho):
    RENDERS.mkdir(parents=True,exist_ok=True)
    sc=bpy.context.scene;sc.render.engine='CYCLES';sc.cycles.samples=24;sc.cycles.use_denoising=True
    sc.render.resolution_x=1600;sc.render.resolution_y=900;sc.render.resolution_percentage=100
    sc.world=bpy.data.worlds.new('Daylight') if sc.world is None else sc.world;sc.world.use_nodes=True;sc.world.node_tree.nodes['Background'].inputs[0].default_value=(.78,.80,.82,1);sc.world.node_tree.nodes['Background'].inputs[1].default_value=.5
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
