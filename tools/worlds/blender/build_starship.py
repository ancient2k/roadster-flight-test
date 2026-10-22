"""Blender 5.2 -b -P tools/worlds/blender/build_starship.py [-- --renders].
Procedural 124 m reference stack. No downloaded assets. Outputs base and LOD1.
"""
import sys, math
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import starbase_common as C
import bpy

def build():
    C.reset(); mats=C.materials(); root=C.empty('Stack'); sh=C.empty('SuperHeavy',root)
    sh['heightIncludingHotStageRingM']=72.; sh['diameterM']=9.
    m=C.Mesh();m.lathe((0,0,0),[(4.5,0),(4.5,2),(4.5,68.8),(4.4,70),(0,70)],n=128)
    # Structural rings are separate from subtle UV weld seams.
    for z in [2,4,18,36,53,66,69.6]:m.ring((0,0,z),4.54,4.49,.12,n=128)
    for a in [math.pi*.75,math.pi*1.75]:
        x,y=4.5*math.cos(a),4.5*math.sin(a);m.beam((x,y,6),(x,y,62),.32,0,.18)
    m.object('BoosterHull',mats,sh)
    # 33 open bells, gimbal origin at the throat, engine plane at Stack Y=0.
    ei=0
    for count,radius,phase in [(3,.75,0),(10,2.25,.16),(20,3.55,0)]:
        for i in range(count):
            a=i*math.tau/count+phase
            e=C.empty(f'Engine_{ei:02d}',sh,(radius*math.cos(a),radius*math.sin(a),2.2));e['gimbalAxis']='local X/Z in glTF'
            q=C.Mesh();q.lathe((0,0,0),[(.18,0),(.24,-.35),(.38,-1),(.62,-2.2),(.56,-2.2),(.32,-1),(.18,-.35)],7,48);q.cylinder((0,0,0),.22,.55,2,24);q.object(f'Nozzle_SH_{ei:02d}',mats,e);ei+=1
    for i in range(4):
        a=math.pi/4+i*math.pi/2
        fin=C.empty(f'GridFin_{i}',sh,(4.4*math.cos(a),4.4*math.sin(a),65));fin.rotation_euler.z=a
        q=C.Mesh()
        # Horizontal open lattice, radial extension 3.8 m, tangential width 3 m.
        for yy in [-1.5,1.5]:q.beam((0,yy,0),(3.8,yy,0),.18,2,.35)
        for xx in [0,3.8]:q.beam((xx,-1.5,0),(xx,1.5,0),.18,2,.35)
        for j in range(1,10):q.beam((j*.38,-1.5,0),(j*.38,1.5,0),.06,2,.3)
        for j in range(1,8):q.beam((0,-1.5+j*.375,0),(3.8,-1.5+j*.375,0),.06,2,.3)
        q.object('Grid_'+str(i),mats,fin)
    pins=C.empty('CatchPins',sh,(0,0,64.5));q=C.Mesh()
    for s in [-1,1]:q.beam((0,s*4.3,0),(0,s*5.5,0),.42,2)
    q.object('CatchPinGeometry',mats,pins)
    ring=C.empty('HotStageRing',sh,(0,0,70));q=C.Mesh()
    q.ring((0,0,0),4.5,4.25,.25,n=128);q.ring((0,0,1.75),4.5,4.25,.25,n=128)
    for i in range(48):
        a=math.tau*i/48;x,y=4.38*math.cos(a),4.38*math.sin(a);q.beam((x,y,.25),(x,y,1.75),.15,0,.24)
    q.object('VentedInterstage',mats,ring)
    C.empty('PlumeOrigin_SH',sh)
    ss=C.empty('Starship',root,(0,0,72));ss['heightM']=52.;ss['windward']='glTF -Z'
    q=C.Mesh();profile=[(4.5,0),(4.5,2),(4.5,34)]
    # Tangent ogive, blunt tip, exact 52 m upper-stage extent.
    for i in range(1,25):
        t=i/24;profile.append((max(.025,4.5*math.sqrt(1-t*t)),34+18*t))
    profile.append((0,52));q.lathe((0,0,0),profile,n=128,half=True);q.object('ShipHull',mats,ss)
    for prefix,z,length,span in [('F',36,8,3.2),('A',4,13,4.8)]:
        for side,sgn in [('L',-1),('R',1)]:
            f=C.empty(f'Flap_{prefix}{side}',ss,(sgn*4.15,0,z));f['hingeAxis']='local +Y in glTF'
            q=C.Mesh();outline=[(0,0), (sgn*span,1.4),(sgn*(span*.85),length*.55),(0,length)]
            # Prism in X/up, thickness across windward/leeward.
            v=[(x,-.18,h) for x,h in outline];w=[(x,.18,h) for x,h in outline]
            q.face(v[::-1],0);q.face(w,6)
            for i in range(4):j=(i+1)%4;q.face([v[i],v[j],w[j],w[i]],2)
            q.beam((0,0,0),(0,0,length),.3,0);q.object(f'FlapSkin_{prefix}{side}',mats,f)
    for prefix,count,radius,bell,phase in [('SL',3,1.1,.65,0),('RVac',3,2.9,1.15,math.pi/3)]:
        for i in range(count):
            a=i*math.tau/count+phase;e=C.empty(f'Engine_{prefix}_{i}',ss,(radius*math.cos(a),radius*math.sin(a),2.3));q=C.Mesh()
            q.lathe((0,0,0),[(.2,0),(.28,-.4),(bell*.65,-1.3),(bell,-2.3),(bell-.065,-2.3),(bell*.59,-1.3),(.2,-.4)],7,64);q.cylinder((0,0,0),.25,.5,2,24);q.object(f'Nozzle_{prefix}_{i}',mats,e)
    C.empty('PlumeOrigin_SS',ss)
    C.export('starship_stack')
    if '--renders' in sys.argv:
        floor=C.ground(mats,size=(260,260,.3))
        for name,eye in [('east',(180,0,65)),('north_windward',(0,180,65)),('west',(-180,0,65)),('south_leeward',(0,-180,65))]:C.render('stack_'+name+'.png',eye,(0,0,62),235)
        for name,eye in [('windward',(0,150,100)),('leeward',(0,-150,100))]:C.render('ship_'+name+'.png',eye,(0,0,98),104)
        bpy.data.objects.remove(floor,do_unlink=True)
    C.export('starship_stack_lod1',lod=True)

if __name__=='__main__':build()
