"""Stream frames and ramp masks for the profile fit.

  python3 tools/ramp/masks.py <tesla_roadster_event_x.mp4> <workdir>

Writes <workdir>/f_<t>.jpg and m_<t>.png: the lit driving surface (grey concrete + red LED edges) as one
filled component inside a region of interest. The frames are not part of the repository.
"""
import os
import subprocess
import sys

import cv2
import numpy as np

# video time -> region of interest (x0, y0, x1, y1); 700/674 s: locked-off wide camera, 720 s: launch camera,
# 727.0/727.5/728.0 s: the same launch camera panned onto the drop
FRAMES = {
    '674.0': (840, 200, 1070, 810), '700.0': (840, 200, 1075, 810), '720.0': (820, 120, 1150, 830),
    '727.0': (1100, 330, 1520, 990), '727.5': (1250, 350, 1560, 1000), '728.0': (1400, 250, 1760, 1000),
}


def ramp_mask(img, roi):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    v, s, h = hsv[..., 2].astype(int), hsv[..., 1].astype(int), hsv[..., 0].astype(int)
    m = (((v > 70) & (s < 60)) | (((h < 10) | (h > 170)) & (s > 100) & (v > 90))).astype(np.uint8) * 255
    x0, y0, x1, y1 = roi
    r = np.zeros_like(m)
    r[y0:y1, x0:x1] = m[y0:y1, x0:x1]
    r = cv2.morphologyEx(r, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(r)
    k = 1 + np.argmax(st[1:, 4])
    out = (lab == k).astype(np.uint8) * 255
    cnts, _ = cv2.findContours(out, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros_like(out)
    cv2.drawContours(out, cnts, -1, 255, -1)
    return out


if __name__ == '__main__':
    video, wd = sys.argv[1], sys.argv[2]
    os.makedirs(wd, exist_ok=True)
    for t, roi in FRAMES.items():
        f = os.path.join(wd, f'f_{t}.jpg')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', t, '-i', video, '-frames:v', '1', f], check=True)
        cv2.imwrite(os.path.join(wd, f'm_{t}.png'), ramp_mask(cv2.imread(f), roi))
        print(t, 'ok')
