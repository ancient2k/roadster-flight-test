"""Shared helpers for the vehicle models Blender build scripts (Blender 5.2, run headless).

Coordinate convention (verified with a probe export, see docs/RENDERING.md):
  The glTF exporter (export_yup=True) maps a Blender vector (bx, by, bz) to glTF (bx, bz, -by),
  and conjugates object rotations accordingly. Our vehicle/glTF frame is +X left, +Y up, +Z forward.
  Therefore a car-frame point (x, y, z) is placed in Blender at (x, -z, y)  -> see B().
  An object's glTF local +Z axis corresponds to its Blender local -Y axis.
All geometry in the build scripts is authored in car/glTF coordinates and converted with B().
"""
from __future__ import annotations

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector


def B(x: float, y: float, z: float) -> Vector:
    """Car/glTF frame (x left, y up, z forward) -> Blender world (x, -z, y)."""
    return Vector((x, -z, y))


def Bv(v) -> Vector:
    return B(v[0], v[1], v[2])


def args_after_dashdash() -> list[str]:
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.objects, bpy.data.images):
        for block in list(coll):
            coll.remove(block)


def link(obj: bpy.types.Object, parent: bpy.types.Object | None = None) -> bpy.types.Object:
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def empty(name: str, loc=(0, 0, 0), parent=None, size=0.1) -> bpy.types.Object:
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = size
    e.location = loc
    return link(e, parent)


# ------------------------------------------------------------------ materials
def _bsdf(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def material(name: str, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.5, *,
             coat=0.0, coat_roughness=0.1, emission=None, emission_strength=0.0,
             alpha=1.0, specular=0.5, ior=1.5, cull=None) -> bpy.types.Material:
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    p = _bsdf(m)
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = roughness
    p.inputs["IOR"].default_value = ior
    if "Specular IOR Level" in p.inputs:
        p.inputs["Specular IOR Level"].default_value = specular
    if coat > 0:
        p.inputs["Coat Weight"].default_value = coat
        p.inputs["Coat Roughness"].default_value = coat_roughness
    if emission is not None:
        p.inputs["Emission Color"].default_value = (*emission, 1.0)
        p.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1.0:
        p.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except (AttributeError, TypeError):
            pass
    m.use_backface_culling = (alpha >= 1.0 and emission is None) if cull is None else cull
    m.diffuse_color = (*color, alpha)
    return m


def image_texture(mat: bpy.types.Material, img: bpy.types.Image, socket: str, *, normal=False,
                  non_color=False, uv_scale=None) -> None:
    """Hook an image into a Principled socket (exported as glTF texture)."""
    nt = mat.node_tree
    p = _bsdf(mat)
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    if non_color or normal:
        img.colorspace_settings.name = "Non-Color"
    if normal:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
    else:
        nt.links.new(tex.outputs["Color"], p.inputs[socket])


def tex(mat: bpy.types.Material, img: bpy.types.Image, socket: str, scale: float = 1.0, *, normal_strength=None,
        channel=None) -> None:
    """Image -> Principled socket through UV Map + Mapping(scale) (exported as KHR_texture_transform)."""
    nt = mat.node_tree
    p = _bsdf(mat)
    uv = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (scale, scale, 1.0)
    nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img
    nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
    if normal_strength is not None:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = normal_strength
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        target = p.inputs["Coat Normal"] if socket == "Coat Normal" else p.inputs["Normal"]
        nt.links.new(nm.outputs["Normal"], target)
    elif channel is not None:
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(t.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs[channel], p.inputs[socket])
    else:
        nt.links.new(t.outputs["Color"], p.inputs[socket])


def box_uv(ob: bpy.types.Object, scale: float = 1.0, mats: set[str] | None = None) -> None:
    """Per-face box projection in object space (1 UV unit = 1/scale metres)."""
    me = ob.data
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    for p in me.polygons:
        if mats is not None and me.materials[p.material_index].name not in mats:
            continue
        n = p.normal
        ax = max(range(3), key=lambda k: abs(n[k]))
        a, b = [(1, 2), (0, 2), (0, 1)][ax]
        flip = -1 if n[ax] < 0 else 1
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = (co[a] * scale * (flip if ax != 2 else 1), co[b] * scale)


# ------------------------------------------------------------------ mesh helpers
def mesh_object(name: str, verts, faces, mats: list[bpy.types.Material] | None = None,
                face_mats: list[int] | None = None, parent=None, loc=(0, 0, 0), uvs=None) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    if uvs is not None:  # per-vertex UVs
        uvl = me.uv_layers.new(name="UVMap")
        for li, lp in enumerate(me.loops):
            uvl.data[li].uv = uvs[lp.vertex_index]
    me.validate(clean_customdata=False)
    if mats:
        for m in mats:
            me.materials.append(m)
        if face_mats:
            for poly, mi in zip(me.polygons, face_mats):
                poly.material_index = mi
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    return link(ob, parent)


def bm_to_object(name: str, bm: bmesh.types.BMesh, mats, parent=None, loc=(0, 0, 0)) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    return link(ob, parent)


def apply_modifiers(ob: bpy.types.Object) -> None:
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)


def shade_by_angle(ob: bpy.types.Object, angle_deg: float = 35.0) -> None:
    me = ob.data
    for p in me.polygons:
        p.use_smooth = True
    try:
        me.set_sharp_from_angle(angle=math.radians(angle_deg))
    except AttributeError:  # older API
        me.use_auto_smooth = True
        me.auto_smooth_angle = math.radians(angle_deg)


def bevel(ob, width=0.004, segments=2, angle_deg=30.0, harden=True, apply=True, limit="ANGLE"):
    md = ob.modifiers.new("Bevel", "BEVEL")
    md.width = width
    md.segments = segments
    md.limit_method = limit
    md.angle_limit = math.radians(angle_deg)
    md.harden_normals = harden
    md.miter_outer = "MITER_ARC"
    md.use_clamp_overlap = True
    if apply:
        apply_modifiers(ob)
    return md


def weighted_normals(ob, apply=True):
    md = ob.modifiers.new("WN", "WEIGHTED_NORMAL")
    md.keep_sharp = True
    md.mode = "FACE_AREA"
    md.weight = 50
    if apply:
        apply_modifiers(ob)


def triangle_count(objs) -> int:
    n = 0
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in objs:
        if ob.type != "MESH":
            continue
        me = ob.evaluated_get(dg).to_mesh()
        me.calc_loop_triangles()
        n += len(me.loop_triangles)
        ob.evaluated_get(dg).to_mesh_clear()
    return n


def lathe(profile, segments: int, axis="X", a0=0.0, a1=2 * math.pi, cap_start=False, cap_end=False,
          closed=None, uv=None):
    """Revolve a (radius, axial) profile around the car-frame X axis (in car coords).
    Returns (verts, faces) in *car* coordinates (x = axial). Profile points: (r, x)."""
    full = closed if closed is not None else abs((a1 - a0) - 2 * math.pi) < 1e-6
    n = segments if full else segments + 1
    verts, faces = [], []
    for i in range(n):
        a = a0 + (a1 - a0) * i / segments
        ca, sa = math.cos(a), math.sin(a)
        for r, x in profile:
            verts.append((x, r * ca, r * sa))
    m = len(profile)
    rows = segments if full else segments
    for i in range(rows):
        i2 = (i + 1) % n
        for j in range(m - 1):
            faces.append((i * m + j, i * m + j + 1, i2 * m + j + 1, i2 * m + j))
    if uv is not None:  # uv = u repeats around; v = normalised arc length along the profile
        acc = [0.0]
        for (r0, x0), (r1, x1) in zip(profile, profile[1:]):
            acc.append(acc[-1] + math.hypot(r1 - r0, x1 - x0))
        tot = acc[-1] or 1.0
        uvs = [(uv * i / segments, acc[j] / tot) for i in range(n) for j in range(m)]
        return verts, faces, uvs
    return verts, faces


def to_blender(verts):
    return [Bv(v) for v in verts]


def export_glb(path: str, objects=None) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    if objects is not None:
        for ob in objects:
            ob.select_set(True)
    kw = dict(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=False,
        use_selection=objects is not None,
    )
    try:
        bpy.ops.export_scene.gltf(**kw, export_image_format="AUTO")
    except TypeError:
        bpy.ops.export_scene.gltf(**kw)
