"""Blender 5.2 -b -P tools/worlds/blender/build_starbase.py [-- --renders].
Build static OSM site, two independently rigged towers and LOD1s. For the combined
preview build_starship.py must have been run first (before asset compression).
"""
import sys, math, json, hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import starbase_common as C
import bpy
from mathutils import Vector
DATA=C.ROOT/'tools/worlds/data/starbase_osm.json'

def points(f):
    p=f['eastNorthM'];return p[:-1] if len(p)>1 and p[0]==p[-1] else p

def center(p):return (sum(x for x,y in p)/len(p),sum(y for x,y in p)/len(p))

def layout(features):
    towers=[];mounts=[]
    for suffix,oid,mp in [('a',968227813,(256.,-94.5)),('b',1207227015,(-104.2,-23.))]:
        f=next(f for f in features if f['osmId']==oid);p=points(f);x,n=center(p);angle=math.atan2(mp[1]-n,mp[0]-x)
        # Local X points from tower to mount. Positive heading = three.js rotation.y.
        towers.append(dict(file=f'tower_{suffix}.glb',x=x,z=-n,headingDeg=math.degrees(angle),heightM=float(f['tags']['height']),osmId=oid,footprintEastNorthM=p))
        mounts.append(dict(id=suffix,x=mp[0],z=-mp[1],y=20.,headingDeg=math.degrees(angle),kind='open_mount' if suffix=='a' else 'water_cooled_trench',positionSource='inferred from OSM catch gantries; mount centre not tagged'))
    return dict(reference=dict(lat=25.997,lon=-97.157),towers=towers,mounts=mounts,stackOnMount=dict(file='starship_stack.glb',mount='a',x=mounts[0]['x'],y=20.,z=mounts[0]['z'],headingDeg=towers[0]['headingDeg']),osmSourceSha256=hashlib.sha256(DATA.read_bytes()).hexdigest())

def tower(t, mount):
    C.reset(); mats=C.materials();root=C.empty('Tower');h=t['heightM'];q=C.Mesh()
    # Preserve measured OSM quadrilateral orientation in the mount-facing local frame.
    a=math.radians(t['headingDeg']);c,s=math.cos(a),math.sin(a)
    corners=[(c*(x-t['x'])+s*(n+t['z']),-s*(x-t['x'])+c*(n+t['z'])) for x,n in t['footprintEastNorthM']]
    for x,y in corners:q.box((x,y,1),(3.2,3.2,2),3);q.beam((x,y,2),(x,y,h-5),.9,0)
    for k in range(10):
        z=3+k*(h-8)/10;top=3+(k+1)*(h-8)/10
        for i in range(4):
            x,y=corners[i];xx,yy=corners[(i+1)%4]
            q.beam((x,y,z),(xx,yy,z),.5,0)
            q.beam((x,y,z),(xx,yy,top),.3,0);q.beam((xx,yy,z),(x,y,top),.3,0)
            # Maintenance catwalk and fine safety rails.
            q.beam((x,y,z+.4),(xx,yy,z+.4),.65,2,.12)
            q.beam((x,y,z+1.4),(xx,yy,z+1.4),.055,0)
            for j in range(7):
                u=j/6;px=x+(xx-x)*u;py=y+(yy-y)*u;q.beam((px,py,z+.4),(px,py,z+1.4),.05,0)
    q.box((0,0,h-3),(12,12,6),1)
    for y in [-4,4]:q.beam((6.5,y,3),(6.5,y,h-6),.35,2)
    q.box((-3,0,h/2),(2,3,h-8),2)
    q.object('TowerStructure',mats,root)
    carriage=C.empty('Carriage',root,(0,0,84));carriage['travelRangeY']=[10,h-18]
    q=C.Mesh();q.box((5.8,0,-3),(2,13,9),2)
    for y in [-5.3,5.3]:q.box((6.5,y,-3),(2.8,1.2,10),0)
    q.object('CarriageFrame',mats,carriage)
    for name,y in [('L',5.3),('R',-5.3)]:
        arm=C.empty('Arm_'+name,carriage,(7,y,0));arm['openAngleDeg']=32 if name=='L' else -32;arm['hingeAxis']='local +Y in glTF';q=C.Mesh()
        for yy in [-.65,.65]:
            for zz in [-3,0]:q.beam((0,yy,zz),(40,yy,zz),.32,0)
        for i in range(10):
            x=i*4
            for yy in [-.65,.65]:q.beam((x,yy,-3),(x+4,yy,0),.17,0);q.beam((x,yy,0),(x+4,yy,-3),.17,0)
            q.beam((x,-.65,0),(x,.65,0),.16,0)
        q.box((22,0,.25),(33,1.05,.5),2)
        q.cylinder((0,0,-3.5),.8,4,0)
        q.object('ArmTruss_'+name,mats,arm);C.empty('Hinge_'+name,carriage,(7,y,0))
    C.empty('CatchPoint',carriage,(math.hypot(t['x']-mount['x'],t['z']-mount['z']),0,.5))
    qd=C.empty('QD_Arm',carriage,(4,-6,22));q=C.Mesh()
    for y in [-.65,.65]:q.beam((0,y,0),(25,y,0),.35,0);q.beam((0,y,2),(25,y,2),.25,0)
    for x in range(0,25,3):q.beam((x,-.65,0),(x+3,-.65,2),.16,0);q.beam((x,.65,0),(x+3,.65,2),.16,0)
    q.box((25,0,0),(2,3,4),1);q.object('QDTruss',mats,qd)
    C.export(t['file'][:-4])
    if '--renders' in sys.argv:
        floor=C.ground(mats,size=(220,220,.3))
        for state,ang in [('closed',0),('open',32)]:
            bpy.data.objects['Arm_L'].rotation_euler.z=math.radians(ang);bpy.data.objects['Arm_R'].rotation_euler.z=-math.radians(ang)
            C.render(t['file'][:-4]+'_'+state+'.png',(185,-210,125),(12,0,73),285)
        bpy.data.objects['Arm_L'].rotation_euler.z=0;bpy.data.objects['Arm_R'].rotation_euler.z=0;bpy.data.objects.remove(floor,do_unlink=True)
    C.export(t['file'][:-4]+'_lod1',lod=True)

def build_site(features):
    C.reset();mats=C.materials();root=C.empty('Starbase');q=C.Mesh();counts={}
    for f in features:
        t=f['tags'];p=points(f);x,y=center(p);kind=None;h=float(t.get('height',4))
        if t.get('man_made')=='tower' or 'building:part' in t:continue
        if t.get('man_made')=='gantry' and 'description' in t:continue # moving tower assemblies, not static duplicates
        if 'natural' in t:continue
        if t.get('layer')=='-1':
            # Ground-level lining, never extrude the erroneous 146 m trench tag.
            q.prism(p,-.12,.15,2);kind='underground_lining'
        elif t.get('man_made')=='storage_tank':
            kind='tank';v=[Vector((px,py)) for px,py in p];edges=[(v[(i+1)%len(v)]-v[i]) for i in range(len(v))];d=max(edges,key=lambda v:v.length).normalized();normal=Vector((-d.y,d.x));along=[v.dot(d) for v in v];across=[v.dot(normal) for v in v];length=max(along)-min(along);width=max(across)-min(across)
            if len(p)<10 and length>width*1.6:
                r=width*.48;z=h/2 if 'height' in t else r+1.2
                a=Vector((x,y))-d*max(0,length/2-r);b=Vector((x,y))+d*max(0,length/2-r)
                # Horizontal pressure vessel: revolved capsule transformed into footprint axis.
                temp=C.Mesh();temp.lathe((0,0,0),[(0,-r),(r*.7,-r*.7),(r,0),(r,(b-a).length),(r*.7,(b-a).length+r*.7),(0,(b-a).length+r)],1,40)
                start=len(q.v)
                for vx,vy,vz in temp.v:q.v.append((a.x+d.x*vz+normal.x*vx,a.y+d.y*vz+normal.y*vx,z+vy))
                q.f.extend([tuple(start+i for i in face) for face in temp.f]);q.m.extend(temp.m);q.uv.extend(temp.uv);q.s.extend(temp.s)
                for sign in [-1,1]:q.box((x+d.x*length*.28*sign,y+d.y*length*.28*sign,.6),(width*.8,width*.8,1.2),3)
            else:
                r=max(math.hypot(px-x,py-y) for px,py in p);hh=h if 'height' in t else 8
                q.lathe((x,y,0),[(0,0),(r,0),(r,hh-.6),(r*.85,hh),(0,hh)],1,48)
                q.ring((x,y,hh*.1),r+.06,r,.12,0,48)
        elif 'building' in t:
            kind='building';h=float(t.get('height',2.6 if t['building']=='container' else 4.))
            q.prism(p,0,h,1 if t['building']=='container' else 3)
            q.prism(p,h,.18,1)
            if h<12:q.box((x,y,h+.4),(1.4,1.2,.8),2)
        elif 'barrier' in t:
            kind='barrier';height=float(t.get('height',2.5 if t['barrier']=='fence' else 3))
            for a,b in zip(f['eastNorthM'],f['eastNorthM'][1:]):
                if t['barrier']=='fence':
                    for z in [.25,1.3,height]:q.beam((*a,z),(*b,z),.045,2)
                    length=math.dist(a,b)
                    for i in range(math.ceil(length/3)+1):
                        u=min(1,i*3/max(length,.001));px=a[0]+(b[0]-a[0])*u;py=a[1]+(b[1]-a[1])*u;q.beam((px,py,0),(px,py,height),.09,2)
                else:q.beam((*a,height/2),(*b,height/2),.3,3,height)
        elif t.get('man_made')=='pipeline':
            kind='pipeline'
            for a,b in zip(p,p[1:]):
                q.pipe((*a,1.8),(*b,1.8),.225,0)
                for pp in [a,b]:q.box((*pp,.85),(.6,.6,1.7),3)
        elif t.get('man_made')=='gantry':
            kind='gantry'
            for a,b in zip(p,p[1:]):q.beam((*a,8),(*b,8),.5,0);q.beam((*a,0),(*a,8),.4,0)
        elif 'highway' in t:
            kind='road';w=9 if t['highway'] in ['tertiary','unclassified'] else 5 if t['highway']=='service' else 2.5
            for a,b in zip(p,p[1:]):q.beam((*a,.035),(*b,.035),w,4 if t.get('surface')=='asphalt' else 3,.07)
        elif f['closed'] and ('surface' in t or t.get('aeroway')=='apron' or t.get('industrial')=='depot'):
            kind='slab';q.prism(p,-.08,.1,3)
        if kind:counts[kind]=counts.get(kind,0)+1
    for mount in LAYOUT['mounts']:
        x,y=mount['x'],-mount['z'];q.ring((x,y,18),10,5.1,2,2,96)
        for i in range(6):
            a=i*math.tau/6;xx,yy=x+8.4*math.cos(a),y+8.4*math.sin(a)
            q.beam((xx,yy,0),(xx,yy,18),1.5,2);q.box((xx,yy,.5),(3,3,1),3)
            q.beam((xx,yy,7),(x+8.4*math.cos(a+math.tau/6),y+8.4*math.sin(a+math.tau/6),18),.45,0)
        if mount['id']=='b':
            # Raised side walls expose a readable open water-cooled trench at ground datum.
            for dx in [-8,8]:q.box((x+dx,y,2),(2,48,4),3)
            q.box((x,y,-.02),(14,48,.12),2)
            for dx in range(-6,7):q.beam((x+dx,y-23,.1),(x+dx,y+23,.1),.09,0)
        else:q.box((x,y,.08),(20,20,.16),0)
    # Inferred area lighting: explicit generated locations, not asserted OSM positions.
    for x,y in [(-145,50),(-40,-70),(75,80),(210,65),(300,-130),(285,-35),(50,-130)]:
        q.cylinder((x,y,0),.18,20,0,16);q.beam((x-2,y,20),(x+2,y,20),.16,0)
        for dx in [-1.6,0,1.6]:q.box((x+dx,y,20),(1,.6,.35),1)
    q.object('SiteStructures',mats,root);root['osmAttribution']='© OpenStreetMap contributors, ODbL 1.0';root['featureCounts']=json.dumps(counts)
    C.export('starbase');return counts

if __name__=='__main__':
    features=json.loads(DATA.read_text())['features'];LAYOUT=layout(features);C.OUT.mkdir(parents=True,exist_ok=True)
    (C.OUT/'starbase_layout.json').write_text(json.dumps(LAYOUT,indent=2)+'\n')
    for t,m in zip(LAYOUT['towers'],LAYOUT['mounts']):tower(t,m)
    counts=build_site(features)
    print('OSM feature classes:',counts)
    if '--renders' in sys.argv:
        mats=[bpy.data.materials[n] for n in ['Steel','White','DarkSteel','Concrete','Asphalt','Sand','Tiles','Engine']];C.ground(mats,(0,0,-.4),(1600,1200,.5))
        for t in LAYOUT['towers']:
            bpy.ops.import_scene.gltf(filepath=str(C.OUT/t['file']));ob=bpy.data.objects['Tower'];ob.name='Placed_'+t['file'];ob.location=(t['x'],-t['z'],0);ob.rotation_euler.z=math.radians(t['headingDeg'])
        if (C.OUT/'starship_stack.glb').exists():
            bpy.ops.import_scene.gltf(filepath=str(C.OUT/'starship_stack.glb'));s=LAYOUT['stackOnMount'];ob=bpy.data.objects['Stack'];ob.location=(s['x'],-s['z'],s['y']);ob.rotation_euler.z=math.radians(s['headingDeg'])
        C.render('site_southwest_40deg.png',(-550,-650,40+math.hypot(650,650)*math.tan(math.radians(40))),(100,0,40),1050)
        m=LAYOUT['mounts'][0];C.render('stack_on_mount.png',(m['x']+230,-m['z']-280,150),(m['x']-10,-m['z'],78),300)
