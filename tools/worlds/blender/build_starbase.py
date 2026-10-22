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
    C.reset();mats=C.materials();root=C.empty('Tower');h=t['heightM'];q=C.Mesh()
    angle=math.radians(t['headingDeg']);c,s=math.cos(angle),math.sin(angle)
    corners=[(c*(x-t['x'])+s*(n+t['z']),-s*(x-t['x'])+c*(n+t['z'])) for x,n in t['footprintEastNorthM']]
    bays=38;pitch=(h-9)/bays
    # Four fabricated box columns: distinct webs/flanges and batten plates.
    for x,y in corners:
        q.box((x,y,.65),(3.4,3.4,1.3),3)
        for dx in [-.52,.52]:q.box((x+dx,y,(h-5)/2),( .14,1.18,h-7),2)
        for dy in [-.52,.52]:q.box((x,y+dy,(h-5)/2),( .9,.14,h-7),2)
        for k in range(bays+1):
            z=2+k*pitch
            for dx in [-.66,.66]:q.box((x+dx,y,z),(.14,1.5,.24),2)
            for dy in [-.66,.66]:q.box((x,y+dy,z),(1.18,.14,.24),2)
    for k in range(bays):
        z=2+k*pitch;top=z+pitch
        for i in range(4):
            x,y=corners[i];xx,yy=corners[(i+1)%4]
            q.girder((x,y,z),(xx,yy,z),.6,.75)
            q.girder((x,y,z+.45),(xx,yy,top-.35),.28,.32,thickness=.045)
            q.girder((xx,yy,z+.45),(x,y,top-.35),.28,.32,thickness=.045)
            # Every level has a narrow catwalk, toe board and two handrails.
            q.beam((x,y,z+.48),(xx,yy,z+.48),.75,2,.12)
            q.beam((x,y,z+.62),(xx,yy,z+.62),.055,2,.19)
            for dz in [1.05,1.55]:q.beam((x,y,z+dz),(xx,yy,z+dz),.05,2)
            for j in range(1,9):
                u=j/9;px=x+(xx-x)*u;py=y+(yy-y)*u
                q.beam((px,py,z+.48),(px,py,z+1.55),.045,2)
        # Switchback stair tower inside the rear half. 12 treads per half-level.
        for flight in [0,1]:
            yy=-2.1+flight*1.8;direction=1 if flight==0 else -1
            x0=-4 if flight==0 else 0;z0=z+flight*pitch/2
            for j in range(12):
                q.box((x0+direction*(j+.5)/3,yy,z0+(j+1)*pitch/24),( .36,1.4,.07),2)
            for dy in [-.72,.72]:
                q.girder((x0,yy+dy,z0),(x0+direction*4,yy+dy,z0+pitch/2),.12,.18,thickness=.035)
                q.beam((x0,yy+dy,z0+1.05),(x0+direction*4,yy+dy,z0+pitch/2+1.05),.045,2)
                for j in range(5):
                    px=x0+direction*j;zz=z0+j*pitch/8
                    q.beam((px,yy+dy,zz),(px,yy+dy,zz+1.05),.045,2)
        for xx in [-4,0]:q.box((xx,-1.2,z+pitch/2),(.9,3.2,.12),2)
        # Elevator cage cross braces; cable-tray rungs keep the interior readable.
        for yy in [1.4,3.4]:
            q.beam((-4.2,yy,z),(-1.8,yy,top),.10,2)
            q.beam((-4.2,yy,z),(-1.8,yy,z),.12,2)
        for xx in [-4.2,-1.8]:q.beam((xx,1.4,z),(xx,3.4,z),.12,2)
        for j in range(9):
            zz=z+j*pitch/9
            for yy in [-3.4,3.8]:q.beam((-1,yy,zz),(.3,yy,zz),.055,2)
    for x in [-4.2,-1.8]:
        for y in [1.4,3.4]:q.beam((x,y,1),(x,y,h-6),.16,2)
    q.box((-3,2.4,9),(2.2,1.8,3),2)
    for y in [-3.4,3.8]:
        for x in [-1,.3]:q.beam((x,y,1),(x,y,h-5),.12,2)
        for x in [-.8,-.5,-.2,.1]:q.pipe((x,y,1),(x,y,h-5),.055,2,10)
    # Rails and suspended cable bundles follow the tower's mount-facing side.
    for y in [-4,4]:
        q.girder((6.5,y,1),(6.5,y,h-5),.45,.6)
        for dy in [-.3,0,.3]:q.pipe((6.9,y+dy,4),(6.9,y+dy,h-4),.045,2,10)
    # Crown: open girders, hoist drums/sheaves, compact housing and short crane boom.
    crown=h-5.5
    for y in [-5,5]:q.girder((-6,y,crown),(9,y,crown),.7,1.1)
    for x in [-6,0,6,9]:q.girder((x,-5,crown),(x,5,crown),.6,.8)
    for x in [-5,5]:
        for y in [-4,4]:q.beam((x,y,crown),(x,y,h-.6),.32,2)
    q.box((-1.8,0,h-2.4),(5.5,6,3.1),2)
    q.box((-1.8,0,h-.7),(6,6.5,.24),1)
    for y in [-3.05,3.05]:
        for j in range(12):q.box((-4+j*.4,y,h-2.4),(.10,.10,1.8),0)
    for y in [-3.5,3.5]:
        q.pipe((5,y-.55,h-2.8),(5,y+.55,h-2.8),.95,2,48)
        for dy in [-.55,.55]:q.pipe((5,y+dy-.05,h-2.8),(5,y+dy+.05,h-2.8),1.08,0,48)
    for y in [-.8,.8]:
        q.girder((0,y,h-1),(12,y,h-1),.25,.4)
        q.beam((0,y,h-.1),(12,y,h-1),.14,2)
    q.pipe((11.5,-.65,h-1.5),(11.5,.65,h-1.5),.55,2,32)
    q.object('TowerStructure',mats,root)
    carriage=C.empty('Carriage',root,(0,0,84));carriage['travelRangeY']=[10,h-18]
    q=C.Mesh()
    # Three-sided wraparound carriage with bogies, rear ties and ram bodies.
    for z in [-8,-4,0]:
        for y in [-7.2,7.2]:q.girder((-7.5,y,z),(7,y,z),.65,.9)
        q.girder((-7.5,-7.2,z),(-7.5,7.2,z),.65,.9)
        q.girder((6,-7.2,z),(6,7.2,z),.8,1.)
    for y in [-7.2,7.2]:
        for x in [-7.5,0,6.5]:q.girder((x,y,-8),(x,y,1),.6,.7)
        for x in [-7.5,-.5]:q.girder((x,y,-8),(x+7,y,0),.4,.5)
    for y in [-5.3,5.3]:
        q.box((6.4,y,-3),(1.8,1.8,7),2)
        for z in [-6,-3,0]:
            q.pipe((6.3,y-.9,z),(6.3,y+.9,z),.65,0,32)
            q.box((5.5,y,z),(1.2,2.1,1.2),2)
        q.pipe((5,y,-7),(6.5,y,-1),.36,2,24)
    q.object('CarriageFrame',mats,carriage)
    for name,y,sign in [('L',5.3,1),('R',-5.3,-1)]:
        arm=C.empty('Arm_'+name,carriage,(7,y,0));arm['openAngleDeg']=32*sign;arm['hingeAxis']='local +Y in glTF';q=C.Mesh()
        # Triangular section grows OUTWARD, leaving the original catch opening clear.
        section=[(-sign*.35,0),(sign*2.6,0),(sign*1.3,-3.8)]
        for yy,zz in section:q.girder((0,yy,zz),(40,yy,zz),.45,.55)
        for j in range(16):
            x=j*2.5
            for k in range(3):
                y0,z0=section[k];y1,z1=section[(k+1)%3]
                q.beam((x,y0,z0),(x,y1,z1),.24,2)
                q.girder((x,y0,z0),(x+2.5,y1,z1),.22,.28,thickness=.045)
            q.box((x+.6,sign*2.5,.12),(1,.65,.18),2)
        # Broad rail and closely spaced transverse rollers on the inner upper face.
        q.box((22,-sign*.05,.28),(34,1.0,.44),2)
        for j in range(48):
            x=5.5+j*.7
            q.pipe((x,-sign*.46,.36),(x,sign*.36,.36),.14,0,12)
            for yy in [-.5,.5]:q.box((x,yy,.04),(.22,.12,.3),2)
        q.cylinder((0,0,-4.1),1.1,4.5,2,48)
        for z in [-4,-.5]:q.ring((0,0,z),1.3,.9,.25,0,48)
        q.pipe((2,sign*2,-2),(10,sign*2,-2),.22,0,24)
        q.object('ArmTruss_'+name,mats,arm);C.empty('Hinge_'+name,carriage,(7,y,0))
    C.empty('CatchPoint',carriage,(math.hypot(t['x']-mount['x'],t['z']-mount['z']),0,.5))
    qd=C.empty('QD_Arm',carriage,(4,-6,22));q=C.Mesh()
    for y in [-1.2,1.2]:
        for z in [-.4,2.6]:q.girder((0,y,z),(25,y,z),.35,.45)
        for j in range(10):
            x=j*2.5;q.beam((x,y,-.4),(x,y,2.6),.22,2)
            q.beam((x,y,-.4),(x+2.5,y,2.6),.18,2)
        q.beam((0,y,1),(24,y,1),.065,2)
    q.box((12,0,-.4),(24,2.4,.16),2);q.box((12,0,2.8),(24,2.8,.16),1)
    # Three-sided service hood, open at the vehicle end.
    q.box((25,0,3),(3.5,4,.25),1)
    for y in [-1.9,1.9]:q.box((25,y,.6),(3.5,.22,4.8),1)
    q.box((23.4,0,.6),(.25,3.8,4.8),2)
    for y in [-.65,.65]:q.path([(0,y,.1),(21,y,.1),(25,y,-.8)],.15,0,16)
    q.object('QDTruss',mats,qd)
    C.export(t['file'][:-4])
    if '--renders' in sys.argv:
        floor=C.ground(mats,size=(220,220,.3))
        for state,ang in [('closed',0),('open',32)]:
            bpy.data.objects['Arm_L'].rotation_euler.z=math.radians(ang);bpy.data.objects['Arm_R'].rotation_euler.z=-math.radians(ang)
            C.render(t['file'][:-4]+'_'+state+'.png',(185,-210,125),(12,0,73),285)
        bpy.data.objects['Arm_L'].rotation_euler.z=0;bpy.data.objects['Arm_R'].rotation_euler.z=0;bpy.data.objects.remove(floor,do_unlink=True)
    C.export(t['file'][:-4]+'_lod1',lod=True)

def launch_mount(q,mount):
    """Local construction transformed around the unchanged mount centre."""
    m=C.Mesh();is_a=mount['id']=='a'
    m.ring((0,0,18),10,5.1,2,2,128)
    # Ring diaphragms, radial girders, inner clamps and outer service railings.
    for i in range(24):
        a=i*math.tau/24;rad=Vector((math.cos(a),math.sin(a),0));tan=Vector((-math.sin(a),math.cos(a),0))
        m.girder(rad*5.2+Vector((0,0,18.5)),rad*9.8+Vector((0,0,18.5)),.3,.65)
        m.beam(rad*9.7+Vector((0,0,20)),rad*9.7+Vector((0,0,21.1)),.07,2)
        b=a+math.tau/24
        for z in [20.6,21.1]:m.beam((9.7*math.cos(a),9.7*math.sin(a),z),(9.7*math.cos(b),9.7*math.sin(b),z),.055,2)
        m.girder(rad*4.55+Vector((0,0,19.75)),rad*6.2+Vector((0,0,19.75)),.40,.45)
        m.pipe(rad*5.5-tan*.30+Vector((0,0,19.55)),rad*5.5+tan*.30+Vector((0,0,19.55)),.23,0,20)
        m.pipe(rad*6.4+Vector((0,0,18.4)),rad*5.7+Vector((0,0,19.6)),.15,0,16)
    if is_a:
        for i in range(6):
            a=i*math.tau/6;rad=Vector((math.cos(a),math.sin(a),0));tan=Vector((-math.sin(a),math.cos(a),0))
            p=rad*8.4
            m.box((p.x,p.y,.6),(3.6,3.6,1.2),3)
            # Fabricated open columns with corner chords, bands and diagonal ties.
            for d in [-.6,.6]:
                for e in [-.6,.6]:
                    pos=p+rad*d+tan*e;m.girder((pos.x,pos.y,1.2),(pos.x,pos.y,18),.32,.45)
            for z in [4,8,12,16]:
                for e in [-.6,.6]:
                    start=p-rad*.6+tan*e;end=p+rad*.6+tan*e
                    m.beam((start.x,start.y,z),(end.x,end.y,z),.24,2)
                    m.beam((start.x,start.y,z-2.7),(end.x,end.y,z),.16,2)
            pp=Vector((8.4*math.cos(a+math.tau/6),8.4*math.sin(a+math.tau/6),0))
            m.girder((p.x,p.y,7),(pp.x,pp.y,17.8),.45,.65)
            m.pipe((p.x,p.y,1),(p.x,p.y,17.5),.2,0,20)
        # Segmented water-cooled steel plate, feed headers and visible cooling ribs.
        for x in range(-9,10,2):m.box((x,0,.20),(1.96,20,.28),0)
        for y in [-9.5,9.5]:
            m.pipe((-10,y,.55),(10,y,.55),.22,0,24)
            for x in range(-8,9,2):m.pipe((x,y,.55),(x,y*.8,.25),.09,0,12)
    else:
        # Concrete launch deck with a circular aperture, over a three-sided trench.
        # Y=-24 is the open mouth; side walls carry the deck, no fourth closing wall.
        for x in [-10,10]:m.box((x,0,9),(3,36,18),3)
        m.box((0,16.5,9),(17,3,18),3)
        m.ring((0,0,16.5),12,5.1,1.5,3,128)
        m.box((0,-5,.05),(17,42,.15),2)
        for x in range(-8,9):
            m.path([(x,13,.3),(x,4,3.5),(x,-4,2),(x,-25,.3)],.065,0,10)
        for x in [-8.4,8.4]:m.pipe((x,14,1),(x,-25,1),.30,0,24)
        # Deflector ramp inside the opening, leaving the mouth visibly open.
        m.prism([(-8,-12),(8,-12),(8,10),(-8,10)],.15,.25,2)
        for x in [-6,6]:m.girder((x,-4,16.5),(x,-4,10),.5,.75)
    # Pipes descend from the launch table on its service side.
    for x in [-2,-1,0,1,2]:m.path([(x,9,19),(x,11,17),(x,11,1),(x,16,1)],.15,0,16)
    # Mount B trench direction follows OSM 1352374225's long edge, not world axes.
    theta=0 if is_a else math.atan2(70.29,-46.0)
    c,s=math.cos(theta),math.sin(theta)
    for face,material,smooth in zip(m.f,m.m,m.s):
        q.face([(mount['x']+c*m.v[i][0]-s*m.v[i][1],-mount['z']+s*m.v[i][0]+c*m.v[i][1],m.v[i][2]) for i in face],material,smooth=smooth)


def build_site(features):
    C.reset();mats=C.materials();root=C.empty('Starbase');q=C.Mesh();counts={}
    for f in features:
        t=f['tags'];p=points(f);x,y=center(p);kind=None;h=float(t.get('height',4))
        if t.get('man_made')=='tower' or 'building:part' in t:continue
        if t.get('man_made')=='gantry' and 'description' in t:continue # moving tower assemblies, not static duplicates
        if 'natural' in t:continue
        if t.get('layer')=='-1':
            # These two long trench polygons caused the dark X when overlaid with
            # our mount plates. They describe below-grade space, not surface slabs.
            # A remains the requested open table; B is rebuilt by launch_mount().
            counts['omitted_underground']=counts.get('omitted_underground',0)+1
            continue
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
            for a,b in zip(p,p[1:]):q.girder((*a,8),(*b,8),.4,.6);q.girder((*a,0),(*a,8),.35,.5)
        elif 'highway' in t:
            kind='road';w=9 if t['highway'] in ['tertiary','unclassified'] else 5 if t['highway']=='service' else 2.5
            for a,b in zip(p,p[1:]):q.beam((*a,.035),(*b,.035),w,4 if t.get('surface')=='asphalt' else 3,.07)
        elif f['closed'] and ('surface' in t or t.get('aeroway')=='apron' or t.get('industrial')=='depot'):
            kind='slab';q.prism(p,-.08,.1,3)
        if kind:counts[kind]=counts.get(kind,0)+1
    for mount in LAYOUT['mounts']:launch_mount(q,mount)
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
