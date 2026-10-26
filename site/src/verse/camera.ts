// An orbit camera with damped input and scripted flights. User input moves
// a goal pose and the live pose eases towards it; a flight drives both along
// an eased path that swings out wide on long hops, so jumping across the
// galaxy reads as travel rather than a cut.

import { clamp, easeInOutCubic, lookAt, perspective, v3, type Mat4, type Vec3 } from './math';

export interface Pose {
  target: Vec3;
  yaw: number;
  pitch: number;
  dist: number;
}

interface Flight {
  from: Pose;
  to: Pose;
  t: number;
  dur: number;
  arc: number;
  onDone?: () => void;
}

export const MIN_DIST = 2.5;
export const MAX_DIST = 1400;
const PITCH_LIMIT = 1.45;

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class OrbitCamera {
  pose: Pose = { target: [0, 0, 0], yaw: 0.6, pitch: 1.1, dist: 900 };
  goal: Pose = { target: [0, 0, 0], yaw: 0.6, pitch: 1.1, dist: 900 };
  fov = (55 * Math.PI) / 180;
  fovKick = 0;
  private flight: Flight | null = null;
  readonly view: Mat4 = new Float32Array(16);
  readonly proj: Mat4 = new Float32Array(16);
  eye: Vec3 = [0, 0, 0];
  right: Vec3 = [1, 0, 0];
  up: Vec3 = [0, 1, 0];
  forward: Vec3 = [0, 0, -1];

  get flying(): boolean {
    return this.flight !== null;
  }

  flyTo(to: Partial<Pose>, dur = 2.2, onDone?: () => void): void {
    const from: Pose = { ...this.pose, target: [...this.pose.target] as Vec3 };
    const dest: Pose = {
      target: to.target ? ([...to.target] as Vec3) : from.target,
      yaw: to.yaw ?? from.yaw,
      pitch: clamp(to.pitch ?? from.pitch, -PITCH_LIMIT, PITCH_LIMIT),
      dist: clamp(to.dist ?? from.dist, MIN_DIST, MAX_DIST),
    };
    // Take the short way round.
    dest.yaw = from.yaw + wrapAngle(dest.yaw - from.yaw);
    const hop = v3.dist(from.target, dest.target);
    const arc = hop > 30 ? Math.min(hop * 0.45, 380) : 0;
    if (dur <= 0.01) {
      this.pose = dest;
      this.goal = { ...dest, target: [...dest.target] as Vec3 };
      onDone?.();
      return;
    }
    this.flight = { from, to: dest, t: 0, dur, arc, onDone };
  }

  cancelFlight(): void {
    if (!this.flight) return;
    this.flight = null;
    this.goal = { ...this.pose, target: [...this.pose.target] as Vec3 };
  }

  orbit(dYaw: number, dPitch: number): void {
    this.cancelFlight();
    this.goal.yaw += dYaw;
    this.goal.pitch = clamp(this.goal.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  zoom(factor: number): void {
    this.cancelFlight();
    this.goal.dist = clamp(this.goal.dist * factor, MIN_DIST, MAX_DIST);
  }

  // Pan in the camera's screen plane; dx/dy in pixels.
  pan(dx: number, dy: number, viewportH: number): void {
    this.cancelFlight();
    const worldPerPx = (2 * this.pose.dist * Math.tan(this.fov / 2)) / viewportH;
    const move = v3.add(v3.scale(this.right, -dx * worldPerPx), v3.scale(this.up, dy * worldPerPx));
    this.goal.target = v3.add(this.goal.target, move);
  }

  update(dt: number, aspect: number): void {
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = easeInOutCubic(f.t);
      const p: Pose = {
        target: v3.lerp(f.from.target, f.to.target, e),
        yaw: f.from.yaw + (f.to.yaw - f.from.yaw) * e,
        pitch: f.from.pitch + (f.to.pitch - f.from.pitch) * e,
        dist: Math.exp(Math.log(f.from.dist) + (Math.log(f.to.dist) - Math.log(f.from.dist)) * e) + f.arc * Math.sin(Math.PI * e),
      };
      this.pose = p;
      this.goal = { ...p, target: [...p.target] as Vec3 };
      if (f.t >= 1) {
        this.flight = null;
        f.onDone?.();
      }
    } else {
      const k = 1 - Math.exp(-dt * 9);
      const g = this.goal, p = this.pose;
      p.target = v3.lerp(p.target, g.target, k);
      p.yaw += (g.yaw - p.yaw) * k;
      p.pitch += (g.pitch - p.pitch) * k;
      p.dist = Math.exp(Math.log(p.dist) + (Math.log(g.dist) - Math.log(p.dist)) * k);
    }
    this.fovKick *= Math.exp(-dt * 2.5);

    const { target, yaw, pitch, dist } = this.pose;
    const cp = Math.cos(pitch);
    this.eye = [
      target[0] + dist * cp * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * cp * Math.cos(yaw),
    ];
    lookAt(this.eye, target, [0, 1, 0], this.view);
    const near = clamp(dist * 0.02, 0.05, 4);
    perspective(this.fov + this.fovKick, aspect, near, 6000, this.proj);
    const m = this.view;
    this.right = [m[0]!, m[4]!, m[8]!];
    this.up = [m[1]!, m[5]!, m[9]!];
    this.forward = [-m[2]!, -m[6]!, -m[10]!];
  }
}
