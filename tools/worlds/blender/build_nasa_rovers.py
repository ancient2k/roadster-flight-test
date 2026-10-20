"""Perseverance und Curiosity aus den offiziellen NASA-3D-Modellen (NASA 3D Resources,
github.com/nasa/NASA-3D-Resources, NASA/JPL-Caltech, frei nutzbar nach den NASA-Medienrichtlinien).

  Blender -b -Y --factory-startup -P tools/worlds/blender/build_nasa_rovers.py -- perseverance|curiosity

Quellen (vorher nach tools/worlds/downloads/_nasa3d/ laden, siehe docs/RENDERING.md):
  Mars_2020_Perseverance_Rover.glb, Curiosity_Rover_MSL_Dirty.blend
glTF-Rahmen wie alle Wahrzeichen: Meter, +Y oben, Ursprung unten Mitte, Vorderseite = lokales +Z.
Perseverance: Mast (Remote Sensing Mast) aus der Transportlage aufgerichtet (Kamerakopf ~2,1 m), Räder und
Federung dezimiert, Texturen auf 1024 px. Curiosity: Hilfsobjekte (Pivots, Kameraziele, Innenteile) entfernt.
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SRC = os.path.join(ROOT, "tools", "worlds", "downloads", "_nasa3d")
WHICH = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "perseverance"


def delete(objs):
    for o in list(objs):
        bpy.data.objects.remove(o, do_unlink=True)


def decimate(o, ratio):
    if ratio >= 1 or o.type != "MESH":
        return
    m = o.modifiers.new("dec", "DECIMATE")
    m.ratio = ratio
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
        bpy.ops.object.modifier_apply(modifier=m.name)


def shrink_images(maxpx=1024):
    for im in bpy.data.images:
        if im.size[0] > maxpx or im.size[1] > maxpx:
            s = maxpx / max(im.size[0], im.size[1])
            im.scale(max(1, int(im.size[0] * s)), max(1, int(im.size[1] * s)))
            im.pack()


def tris():
    n = 0
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            n += len(o.data.loop_triangles)
    return n


def bake_transforms():
    """World matrices into the mesh data (single-user), no parents, no animation, no constraints."""
    bpy.context.view_layer.update()
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    mw = {o.name: o.matrix_world.copy() for o in objs}
    for o in objs:
        if o.data.users > 1:
            o.data = o.data.copy()
    for o in objs:
        for md in list(o.modifiers):
            if md.type == "ARMATURE":
                o.modifiers.remove(md)
        o.vertex_groups.clear()
    for o in bpy.context.scene.objects:
        o.animation_data_clear()
        for c in list(o.constraints):
            o.constraints.remove(c)
    for o in objs:
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
        o.data.transform(mw[o.name])
        if mw[o.name].determinant() < 0:
            o.data.flip_normals()
    bpy.context.view_layer.update()


def join_all(name, ratio):
    """One mesh (draw calls = materials, not parts) and an overall decimation for the game budget."""
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    decimate(ob, ratio)


def export(path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.context.scene.objects:
        o.select_set(o.type == "MESH")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_yup=True, export_apply=True, use_selection=True,
                              export_texcoords=True, export_normals=True, export_materials="EXPORT", export_cameras=False,
                              export_lights=False, export_animations=False, export_image_format="AUTO", export_jpeg_quality=85)
    print(f"[r5] {WHICH}: {tris()} tris -> {path} ({os.path.getsize(path) / 1024:.0f} KiB)")


def front_to_plus_z():
    """NASA models face Blender −Y; glTF export maps Blender −Y to +Z (front = local +Z)."""
    pass


def perseverance():
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, "Mars_2020_Perseverance_Rover.glb"))
    bake_transforms()
    junk = [o for o in bpy.context.scene.objects if o.type != "MESH" or o.name.startswith("Icosphere")
            or (o.type == "MESH" and all(m and m.name.startswith("transparent") for m in o.data.materials))]
    delete(junk)
    # Remote Sensing Mast: stowed along the deck (+Y = rearward), hinge at its front base -> rotate 90° up about X
    mast = [o for o in bpy.context.scene.objects if o.name.split(".")[0] in
            ("bottom", "probe", "top", "head", "lens", "Mastcam_Z_cams", "microphones", "NavCams")]
    print("[r5] mast parts:", [o.name for o in mast])
    pivot = Vector((-0.56, -0.80, 1.22))
    R = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(90), 4, "X") @ Matrix.Translation(-pivot)
    HEAD = ("head", "lens", "Mastcam_Z_cams", "NavCams", "microphones")
    head = [o for o in mast if o.name.split(".")[0] in HEAD and o.name != "microphones"]
    tube = [o for o in mast if o not in head and o.name != "microphones"]
    for o in tube:
        o.data.transform(R)
    # the camera head rides to the top of the raised mast but keeps its modelled (level) orientation
    pts = [v.co.copy() for o in head for v in o.data.vertices]
    c0 = sum(pts, Vector()) / len(pts)
    c1 = R @ c0
    for o in head:
        o.data.transform(Matrix.Translation(c1 - c0))
    zs = [(v.co).z for o in head for v in o.data.vertices]
    ys = [(v.co).y for o in head for v in o.data.vertices]
    print(f"[r5] mast head after deploy: z {min(zs):.2f}..{max(zs):.2f}, y {min(ys):.2f}..{max(ys):.2f}")
    for o in bpy.context.scene.objects:
        n = o.name
        if n.startswith("Wheels_objs"):
            decimate(o, 0.2)
        elif n.startswith("suspension") or n.startswith("hazcams") or n.startswith("turret_obj") or n.startswith("rtg") or n.startswith("Body_Parts") or n.startswith("lab"):
            decimate(o, 0.35)
    join_all("Perseverance", 0.55)
    shrink_images(512)
    export(os.path.join(ROOT, "public", "assets", "worlds", "mars_jezero", "perseverance.glb"))


def curiosity():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(SRC, "Curiosity_Rover_MSL_Dirty.blend"), load_ui=False)
    for o in bpy.context.scene.objects:
        o.hide_set(False)
    bake_transforms()   # before deleting the pivot parents (else the parts fly apart)
    # the .blend shades with Diffuse BSDF (not exported to glTF): rebuild as Principled (dusty, matte)
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        nt = m.node_tree
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None) or next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
        surf = out.inputs["Surface"].links[0].from_node if out and out.inputs["Surface"].links else None
        if surf is None or surf.type == "BSDF_PRINCIPLED":
            continue
        img = None
        if "Color" in surf.inputs and surf.inputs["Color"].links:
            img = surf.inputs["Color"].links[0].from_node
        if img is None:
            img = next((n for n in nt.nodes if n.type == "TEX_IMAGE" and n.image), None)
        p = nt.nodes.new("ShaderNodeBsdfPrincipled")
        p.inputs["Roughness"].default_value = 0.72
        p.inputs["Metallic"].default_value = 0.0
        if img is not None and getattr(img, "image", None):
            nt.links.new(img.outputs["Color"], p.inputs["Base Color"])
        else:
            p.inputs["Base Color"].default_value = (*surf.inputs["Color"].default_value[:3], 1) if "Color" in surf.inputs else (0.6, 0.6, 0.6, 1)
        nt.links.new(p.outputs["BSDF"], out.inputs["Surface"])
    junk = [o for o in bpy.context.scene.objects if o.type != "MESH" or not o.data.materials
            or o.name.endswith("_p") or o.name.endswith("_i")
            or all(m and m.name == "pivot" for m in o.data.materials)]
    delete(junk)
    for im in bpy.data.images:
        if im.source == "FILE" and not im.packed_file:
            print("[r5] image", im.name, im.filepath, im.size[:])
    join_all("Curiosity", 1.0)
    shrink_images(512)
    export(os.path.join(ROOT, "public", "assets", "worlds", "mars_gale", "curiosity.glb"))


if WHICH == "perseverance":
    bpy.ops.wm.read_factory_settings(use_empty=True)
    perseverance()
else:
    curiosity()
