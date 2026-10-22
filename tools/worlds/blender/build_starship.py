"""Blender 5.2 -b -P tools/worlds/blender/build_starship.py [-- --renders].
Procedural 124 m reference stack. No downloaded assets. Outputs base and LOD1.
"""
import sys, math
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import starbase_common as C
import bpy
import numpy as np
from mathutils import Vector

def nozzle(q,bell,length,n=48):
    """Open thin-walled bell with a throat, cooling bands and a compact powerhead."""
    profile=[(.18,0),(.22,-.25),(.29,-.5),(bell*.48,-length*.45),
             (bell*.70,-length*.7),(bell,-length),(bell-.045,-length),
             (bell*.70-.045,-length*.7),(bell*.48-.045,-length*.45),(.24,-.5),(.17,-.25)]
    q.lathe((0,0,0),profile,7,n)
    for fraction in [.5,.72,.95]:
        r=bell*(.48+(.70-.48)*(fraction-.45)/.25) if fraction<.7 else bell*(.70+.30*(fraction-.7)/.3)
        q.ring((0,0,-length*fraction),r+.025,max(.08,r-.01),.045,0,32)
    q.cylinder((0,0,.05),.20,.65,7,20)
    q.pipe((-.28,0,.1),(-.28,0,.5),.15,7,16)
    q.path([(.25,0,.6),(.38,0,.4),(.38,0,-.45),(.27,0,-.6)],.055,0,12)
    q.box((0,0,.65),(.55,.45,.15),2)


def ship_hull(q):
    """Shared seam vertices: a sawtooth tile edge rather than overlapping tile skins."""
    step=.15*math.sqrt(3)
    heights=[0.0]+[i*step for i in range(1,int(52/step)+1)]+[52.0]
    def radius(z):return 4.5 if z<=34 else max(0.,4.5*math.sqrt(max(0.,1-((z-34)/18)**2)))
    def ring(z,index):
        r=radius(z);delta=(.075 if index%2 else -.075)/max(r,.4)
        # First half is windward (+north); second is leeward. Same edge on both.
        angles=[delta+(math.pi-2*delta)*i/64 for i in range(65)]
        angles += [math.pi-delta+(math.pi+2*delta)*i/64 for i in range(1,65)]
        return [(r*math.cos(a),r*math.sin(a),z) for a in angles],angles
    rings=[ring(z,i) for i,z in enumerate(heights)]
    for j in range(len(heights)-1):
        p,a=rings[j];pp,aa=rings[j+1]
        for i in range(128):
            mat=6 if i<64 or heights[j]>=51.4 else 0
            sx,sy=(C.TILE_U,C.TILE_V) if mat==6 else (1.8,1.8)
            # Cylindrical mapping on the tank, circumference-aware taper on the nose.
            uv=[(theta*max(radius(z),.15)/sx,z/sy) for theta,z in
                [(a[i],heights[j]),(a[i+1],heights[j]),(aa[i+1],heights[j+1]),(aa[i],heights[j+1])]]
            q.face([p[i],p[i+1],pp[i+1],pp[i]],mat,uv,True)
    # Aft rim has thickness but no bottom cap: all six bells remain visible below.
    q.ring((0,0,0),4.5,4.34,.22,0,128)
    q.lathe((0,0,0),[(4.34,.22),(4.34,2.6)],2,128)


def build():
    C.reset();mats=C.materials();root=C.empty('Stack');sh=C.empty('SuperHeavy',root)
    sh['heightIncludingHotStageRingM']=72.;sh['diameterM']=9.
    m=C.Mesh()
    m.lathe((0,0,0),[(4.5,0),(4.5,2),(4.5,68.8),(4.4,70),(0,70)],n=160)
    m.ring((0,0,0),4.5,4.32,.25,0,160)
    m.lathe((0,0,0),[(4.32,.25),(4.32,3.2)],2,128)
    # Circumferential weld/dome attachment bands; 1.8 m panel seams also live in maps.
    for z in [2.8,5.4,19.8,21.6,37.8,39.6,55.8,66.6,69.6]:m.ring((0,0,z),4.516,4.49,.045,n=128)
    # Raceway covers, round parallel conduits and clips span almost the full stage.
    for a in [math.pi*.75,math.pi*1.75]:
        rx,ry=math.cos(a),math.sin(a);tx,ty=-ry,rx
        m.beam((rx*4.58,ry*4.58,1.5),(rx*4.58,ry*4.58,69),.32,0,.22)
        for sign in [-1,1]:
            x,y=rx*4.59+tx*sign*.25,ry*4.59+ty*sign*.25
            m.pipe((x,y,1.8),(x,y,68.5),.075,0,16)
        for z in range(3,69,3):
            m.beam((rx*4.61-tx*.4,ry*4.61-ty*.4,z),(rx*4.61+tx*.4,ry*4.61+ty*.4,z),.10,2,.12)
    # Lower-body chines, tapered outward rib profiles in four quadrants.
    for i in range(4):
        a=i*math.pi/2+math.pi/4;rad=Vector((math.cos(a),math.sin(a),0));tan=Vector((-math.sin(a),math.cos(a),0))
        outline=[(4.46,1),(5.2,1.5),(5.05,12),(4.46,16)]
        left=[rad*r+tan*.22+Vector((0,0,z)) for r,z in outline]
        right=[rad*r-tan*.22+Vector((0,0,z)) for r,z in outline]
        m.face(left,0);m.face(right[::-1],0)
        for j in range(4):k=(j+1)%4;m.face([left[j],left[k],right[k],right[j]],0)
    # Visible thrust frame sits above the bells, without a disc across their mouths.
    for i in range(12):
        a=i*math.tau/12;m.girder((0,0,3.25),(4.3*math.cos(a),4.3*math.sin(a),3.25),.15,.25,2,.035)
    m.object('BoosterHull',mats,sh)
    ei=0
    for count,radius,phase in [(3,.75,0),(10,2.25,.16),(20,3.55,0)]:
        for i in range(count):
            a=i*math.tau/count+phase
            e=C.empty(f'Engine_{ei:02d}',sh,(radius*math.cos(a),radius*math.sin(a),2.2));e['gimbalAxis']='local X/Z in glTF'
            q=C.Mesh();nozzle(q,.51,2.2);q.object(f'Nozzle_SH_{ei:02d}',mats,e);ei+=1
    for i in range(4):
        a=math.pi/4+i*math.pi/2
        fin=C.empty(f'GridFin_{i}',sh,(4.4*math.cos(a),4.4*math.sin(a),65));fin.rotation_euler.z=a
        q=C.Mesh()
        # 6 m radial × 3 m tangential lattice panel, .48 m deep.
        for yy in [-1.5,1.5]:q.beam((0,yy,0),(6,yy,0),.20,2,.48)
        for xx in [0,6]:q.beam((xx,-1.5,0),(xx,1.5,0),.20,2,.48)
        for j in range(1,20):q.beam((j*.3,-1.4,0),(j*.3,1.4,0),.065,2,.40)
        for j in range(1,10):q.beam((.1,-1.5+j*.3,0),(5.9,-1.5+j*.3,0),.065,2,.40)
        q.pipe((0,-.8,0),(0,.8,0),.32,0,32)
        q.object('Grid_'+str(i),mats,fin)
    pins=C.empty('CatchPins',sh,(0,0,64.5));q=C.Mesh()
    for sign in [-1,1]:
        q.pipe((0,sign*4.3,0),(0,sign*5.5,0),.25,2,32)
        q.box((0,sign*4.48,-.3),(.8,.25,1.1),0)
    q.object('CatchPinGeometry',mats,pins)
    ring=C.empty('HotStageRing',sh,(0,0,70));q=C.Mesh()
    q.ring((0,0,0),4.5,4.25,.25,n=128);q.ring((0,0,1.75),4.5,4.25,.25,n=128)
    for i in range(64):
        a=math.tau*i/64;x,y=4.38*math.cos(a),4.38*math.sin(a);q.beam((x,y,.25),(x,y,1.75),.13,0,.24)
    q.object('VentedInterstage',mats,ring);C.empty('PlumeOrigin_SH',sh)
    ss=C.empty('Starship',root,(0,0,72));ss['heightM']=52.;ss['windward']='glTF -Z'
    q=C.Mesh();ship_hull(q);q.object('ShipHull',mats,ss)
    for prefix,z,length,span in [('F',36,8,3.2),('A',4,13,4.8)]:
        for side,sgn in [('L',-1),('R',1)]:
            f=C.empty(f'Flap_{prefix}{side}',ss,(sgn*4.15,0,z));f['hingeAxis']='local +Y in glTF'
            q=C.Mesh();outline=[(0,0),(sgn*span,1.4),(sgn*(span*.85),length*.55),(0,length)]
            v=[(x,-.18,h) for x,h in outline];w=[(x,.18,h) for x,h in outline]
            q.face(v[::-1],0);q.face(w,6)
            for i in range(4):j=(i+1)%4;q.face([v[i],v[j],w[j],w[i]],2)
            q.pipe((0,0,0),(0,0,length),.17,0,24)
            for h in np.arange(.5,length,.75):q.pipe((0,0,h),(0,0,h+.18),.23,2,16)
            q.object(f'FlapSkin_{prefix}{side}',mats,f)
    for prefix,count,radius,bell,phase in [('SL',3,1.1,.65,0),('RVac',3,2.9,1.15,math.pi/3)]:
        for i in range(count):
            a=i*math.tau/count+phase;e=C.empty(f'Engine_{prefix}_{i}',ss,(radius*math.cos(a),radius*math.sin(a),2.3));q=C.Mesh()
            nozzle(q,bell,2.3,64);q.object(f'Nozzle_{prefix}_{i}',mats,e)
    C.empty('PlumeOrigin_SS',ss)
    C.export('starship_stack')
    if '--renders' in sys.argv:
        floor=C.ground(mats,size=(260,260,.3))
        for name,eye in [('east',(180,0,65)),('north_windward',(0,180,65)),('west',(-180,0,65)),('south_leeward',(0,-180,65))]:C.render('stack_'+name+'.png',eye,(0,0,62),235)
        for name,eye in [('windward',(0,150,100)),('leeward',(0,-150,100))]:C.render('ship_'+name+'.png',eye,(0,0,98),104)
        bpy.data.objects.remove(floor,do_unlink=True)
        # Additional review evidence: the existing side views cannot show engine counts.
        C.render('booster_engines_below.png',(12,-16,-22),(0,0,1),28)
        # Hide the booster subtree only for the upper-stage underside inspection.
        for ob in [sh]+list(sh.children_recursive):ob.hide_render=True
        C.render('ship_engines_below.png',(12,-16,48),(0,0,73),28)
        for ob in [sh]+list(sh.children_recursive):ob.hide_render=False
    C.export('starship_stack_lod1',lod=True)

if __name__=='__main__':build()
