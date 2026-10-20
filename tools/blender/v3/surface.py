"""Body surface model (numpy, no Blender): a closed ring of half-profile control points per station,
lofted along z as a uniform cubic B-spline (= Catmull-Clark limit surface of the regular cage).

Design lines are rows of the cage (one profile index followed along all stations). Sharp facets are
made by control-point multiplicity: a profile point with mult 3 gives an exact crease along that
design line, mult 2 a tight radius. The same holds for stations (cross creases, e.g. the edge of the
front face). End stations collapse to the face centre, so nose and tail faces are part of the same
surface (no separate caps).

The evaluated mesh is exactly what is exported (Blender only adds details, gaps and materials), so
the silhouette fit in fit.py optimises the geometry that ends up in the GLB.

Coordinates: car frame, x left, y up, z forward, metres; heights in the table are above ground
(yg), y = yg + GROUND_Y.
"""
import json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
GROUND_Y = -0.44


def bspline_basis_matrix():
    return np.array([[-1, 3, -3, 1], [3, -6, 3, 0], [-3, 0, 3, 0], [1, 4, 1, 0]], float) / 6.0


def expand(P, mult, axis, closed):
    """Repeat control rows by multiplicity along an axis; clamp open ends (mult 3)."""
    reps = np.asarray(mult, int)
    Q = np.repeat(P, reps, axis=axis)
    if not closed:
        first = np.take(Q, [0], axis=axis); last = np.take(Q, [-1], axis=axis)
        Q = np.concatenate([first, first, Q, last, last], axis=axis)
    return Q, np.repeat(np.arange(len(reps)), reps)


def eval_curve_samples(n_ctrl, closed, per_span):
    """Sample parameters: returns (span index, t) arrays for a uniform cubic B-spline."""
    spans = n_ctrl if closed else n_ctrl - 3
    t = np.linspace(0, 1, per_span, endpoint=False)
    si = np.repeat(np.arange(spans), per_span); tt = np.tile(t, spans)
    if not closed:
        si = np.append(si, spans - 1); tt = np.append(tt, 1.0)
    return si, tt


def basis(tt):
    T = np.stack([tt ** 3, tt ** 2, tt, np.ones_like(tt)], 1)
    return T @ bspline_basis_matrix()


class Body:
    """Station table -> control net -> dense surface grid."""

    def __init__(self, spec):
        self.spec = spec
        self.z = np.array([s["z"] for s in spec["stations"]], float)
        self.ns = len(self.z)
        self.np_ = len(spec["profile"])
        self.pmult = [p.get("mult", 1) for p in spec["profile"]]
        self.smult = [s.get("mult", 1) for s in spec["stations"]]

    def control_points(self, table=None):
        """table: (ns, np, 2) of (x, yg) [+ optional dz in spec]. Returns (ns, ring, 3) closed ring
        going bottom centre -> left side -> top centre -> right side (mirrored) -> back."""
        T = np.asarray(self.spec["table"] if table is None else table, float)
        dz = np.asarray(self.spec.get("dz", np.zeros(T.shape[:2])), float)
        X = T[..., 0]; Y = T[..., 1] + GROUND_Y; Z = self.z[:, None] + dz
        left = np.stack([X, Y, Z], -1)                     # (ns, np, 3), j = 0 bottom centre .. np-1 top centre
        right = left[:, -2:0:-1].copy(); right[..., 0] *= -1  # top -> bottom, excluding centre points
        ring = np.concatenate([left, right], 1)
        mult = self.pmult + self.pmult[-2:0:-1]
        return ring, mult

    def grid(self, table=None, per_u=4, per_v=4):
        """Dense surface samples (nv_samples, nu_samples, 3) and their (station, profile) source ids."""
        ring, umult = self.control_points(table)
        P, uid = expand(ring, umult, axis=1, closed=True)
        P, vid = expand(P, self.smult, axis=0, closed=False)
        nu = P.shape[1]; nv = P.shape[0]
        su, tu = eval_curve_samples(nu, True, per_u)
        sv, tv = eval_curve_samples(nv, False, per_v)
        Bu = basis(tu); Bv = basis(tv)
        iu = (su[:, None] + np.arange(4)[None]) % nu          # (Nu, 4)
        iv = sv[:, None] + np.arange(4)[None]                # (Nv, 4)
        G = P[iv][:, :, iu]                                  # (Nv, 4, Nu, 4, 3)
        S = np.einsum("va,vaubk,ub->vuk", Bv, G, Bu)
        # design parameters of every sample: basis-weighted original control index, so a material or
        # door boundary placed on a crease (mult 3) lands exactly on the crease line
        upar = (Bu * uid[iu]).sum(1)                         # ring index space (wraps at nu)
        wrap = np.abs(uid[iu] - uid[iu][:, :1]).max(1) > len(uid) // 2
        if wrap.any():                                       # samples straddling the ring seam
            ui = uid[iu].astype(float)
            ui[wrap] = np.where(ui[wrap] > len(uid) // 2, ui[wrap] - (max(uid) + 1), ui[wrap])
            upar = (Bu * ui).sum(1) % (max(uid) + 1)
        vid_full = np.concatenate([[vid[0]] * 2, vid, [vid[-1]] * 2])
        vpar = (Bv * vid_full[iv]).sum(1)
        self.upar, self.vpar = upar, vpar
        return S, upar, vpar

    def mesh(self, table=None, per_u=4, per_v=4):
        """Triangles of the closed surface grid: verts (N,3), quads (M,4)."""
        S, U, V = self.grid(table, per_u, per_v)
        nv, nu = S.shape[:2]
        verts = S.reshape(-1, 3)
        a = np.arange(nv - 1)[:, None] * nu + np.arange(nu)[None]
        b = np.arange(nv - 1)[:, None] * nu + (np.arange(nu)[None] + 1) % nu
        quads = np.stack([a, b, b + nu, a + nu], -1).reshape(-1, 4)
        return verts, quads, S, U, V


    def profile_param(self, upar):
        """Ring parameter -> (half-profile parameter 0..np-1, side +1 left / -1 right)."""
        n = self.np_ - 1
        side = np.where(upar <= n, 1, -1)
        return np.where(upar <= n, upar, 2 * n - upar), side


def load_spec(path=None):
    return json.load(open(path or os.path.join(HERE, "body_spec.json")))
