// planes.js — per-plane flight models and guns. Each type lists only what differs from CONFIG: a
// spec is CONFIG with the type's own values laid over it (prototype fallback), so flightStep reads
// spec.PITCH_RATE etc. the same way whatever the plane. The jet is the game as it has always
// flown, i.e. the CONFIG values unchanged.
// Pure: no DOM, no THREE.
//
// WW2 planes (ERA 'ww2') fly a less arcade model, in real units:
// - PROP: thrust = POWER × throttle / speed (a propeller's thrust fades as speed rises), drag ∝
//   speed² (DRAG_K, set so full throttle levels off at SPEED_MAX), gravity at 9.81 (CLIMB_DRAG):
//   zoom climbs and dives trade real height for speed, so the fight goes vertical (the "egg").
// - Turns bleed TURN_BLEED × (G−1)² × (CORNER_SPEED / speed)² (induced drag ∝ (G / speed)²): a
//   hard pull costs far more slow than fast, so fast pulls can over-stress the wing.
// - Real G (A_PER_G 9.81). Pull rate is lift-limited below CORNER_SPEED and keeps growing above
//   it (lift ∝ speed²): nothing stops you pulling more than the wing takes (G_LIMIT) except stick
//   forces, which grow heavy with speed (STIFF_*). Over the limit the wing takes stress; held too
//   long it fails (flight.js).
// - NEG_G_CUT: a float carburettor (Spitfire Mk I's Merlin) starves under negative G and the
//   engine cuts for a moment. The 109's fuel injection doesn't care: push over and dive away.
// - GUNS: per-gun position (x right, y up of the nose, m), rate (rounds/s; one game round stands
//   for a few real ones), muzzle speed, power (damage in jet-gun rounds) and ammo. group 'mg' fires
//   on the pinch; 'cannon' joins in on the fist. Wing guns aim to cross at CONVERGENCE metres.
// - No lead marker, no gun assist, no missiles (LEAD/MISSILES false): you read the lead off your
//   tracers. The sight is a fixed reflector ring sized to a fighter's wingspan at SIGHT_RANGE.

const WW2 = {
  ERA: 'ww2', PROP: true, MISSILES: false, LEAD: false,
  A_PER_G: 9.81, CLIMB_DRAG: 9.81, V_STATIC: 80,   // thrust stops growing below V_STATIC (static thrust)
  SPEED_FLOOR: 20, PITCH_LOW_EXP: 1, PITCH_HIGH_EXP: 1, PUSH_SHARE: 0.6,
  YAW_RATE: 0.25, SLIP_GRIP: 6, ROLL_MIN: 0.4,
  OVER_G_STRESS: 2,          // wing stress per second per unit of overload (G / G_LIMIT − 1): 1.25× fails in 2 s
  OVER_G_HEAL: 0.15,         // stress drains this much per second back under the limit
  OVER_G_WARN: 0.9,          // creak + amber G from this share of the limit
  HIT_R: 7,                  // gun hit radius (m) on these planes: a ~11 m wingspan, a little generous
  // Hidden gun assist (no lead marker on screen): rounds bend onto the solved lead when the nose
  // is within ASSIST_SCALE × the gun-assist slider of it, inside GUN_ASSIST_RANGE. Hands on a
  // camera can't hold the last degree steady; you still have to get the nose there.
  ASSIST_SCALE: 1.5, GUN_ASSIST_RANGE: 600,
  SIGHT_RANGE: 125, SIGHT_SPAN: 11,   // a fighter fills the sight ring at 125 m, half of it at ~250 m (convergence)
  CHASE_BACK: 20, CHASE_UP: 4.5,      // chase camera (the lag adds ~speed / 7 m)
  VAPOR_MIN_RATE: 0.22, VAPOR_FULL_RATE: 0.3,
  WINGTIP: { out: 5.4, back: 0.8 },
};

// Tuned with test/planes.js report: climb Spitfire 13.8 / 109 15.8 / P-51 17.6 m/s; best sustained
// 360° ~15 / ~19 / ~19 s (real ~19 / ~22 / ~22: ~25% quicker for the game, same order).
const PLANES = {
  jet: { name: 'JET', ERA: 'jet' },

  // Supermarine Spitfire Mk I: turns well, rolls poorly at speed, eight light machine guns, and the
  // float carburettor that cuts out under negative G.
  spitfire: { ...WW2, name: 'SPITFIRE MK I',
    SPEED_MIN: 60, SPEED_MAX: 160, POWER: 155, CORNER_SPEED: 108, G_LIMIT: 7, STALL_SPEED: 40,
    TURN_BLEED: 0.2, ROLL_RATE: 1.6, ROLL_FULL_SPEED: 80, STIFF_SPEED: 100, STIFF_RANGE: 110, STIFF_MIN: 0.5,
    NEG_G_CUT: 1.4,
    CONVERGENCE: 230,
    GUNS: [-3.3, -2.9, -2.4, -2.0, 2.0, 2.4, 2.9, 3.3].map(x => ({ group: 'mg', x, y: -0.2, rate: 5, speed: 745, power: 0.25, ammo: 75 })),
  },
  // Messerschmitt Bf 109E: climbs better, turns wider, elevator heavy at speed, fuel injection;
  // two cowl machine guns plus two slow, hard-hitting 20 mm wing cannons with small drums.
  bf109: { ...WW2, name: 'BF 109E',
    SPEED_MIN: 60, SPEED_MAX: 155, POWER: 180, CORNER_SPEED: 128, G_LIMIT: 7, STALL_SPEED: 44,
    TURN_BLEED: 0.3, ROLL_RATE: 1.8, ROLL_FULL_SPEED: 85, STIFF_SPEED: 115, STIFF_RANGE: 100, STIFF_MIN: 0.4,
    CONVERGENCE: 250,
    GUNS: [
      { group: 'mg', x: -0.3, y: 0.6, rate: 5, speed: 750, power: 0.25, ammo: 250 },
      { group: 'mg', x: 0.3, y: 0.6, rate: 5, speed: 750, power: 0.25, ammo: 250 },
      { group: 'cannon', x: -2.5, y: -0.2, rate: 4, speed: 600, power: 4, ammo: 28 },
      { group: 'cannon', x: 2.5, y: -0.2, rate: 4, speed: 600, power: 4, ammo: 28 },
    ],
  },
  // North American P-51D Mustang: fast, rolls well at speed, keeps its energy, six .50s.
  p51: { ...WW2, name: 'P-51D',
    SPEED_MIN: 65, SPEED_MAX: 195, POWER: 185, CORNER_SPEED: 140, G_LIMIT: 8, STALL_SPEED: 48,
    TURN_BLEED: 0.25, ROLL_RATE: 2, ROLL_FULL_SPEED: 100, STIFF_SPEED: 160, STIFF_RANGE: 140, STIFF_MIN: 0.5,
    CONVERGENCE: 270,
    GUNS: [-3.4, -3.0, -2.6, 2.6, 3.0, 3.4].map(x => ({ group: 'mg', x, y: -0.2, rate: 5, speed: 870, power: 0.4, ammo: 125 })),
  },
};
const DEFAULT_PLANE = 'jet';
const PLANE_ORDER = ['jet', 'spitfire', 'bf109', 'p51'];
// Who a bandit flies against each plane in dogfight mode.
const PLANE_ENEMY = { jet: 'jet', spitfire: 'bf109', bf109: 'spitfire', p51: 'bf109' };

const SPEC_CACHE = {};
function planeSpec(type) {
  const t = PLANES[type] ? type : DEFAULT_PLANE;
  if (SPEC_CACHE[t]) return SPEC_CACHE[t];
  const s = Object.assign(Object.create(CONFIG), PLANES[t], { type: t });
  // Full-throttle level flight balances at SPEED_MAX: POWER / v = DRAG_K v².
  if (s.PROP) s.DRAG_K = s.POWER / Math.pow(s.SPEED_MAX, 3);
  // Pull rate at corner speed = exactly the wing's limit.
  if (s.G_LIMIT) s.PITCH_RATE = (s.G_LIMIT - 1) * s.A_PER_G / s.CORNER_SPEED;
  // Assist (bank = turn) turns at most this fast at 90° of bank.
  if (s.G_LIMIT) s.TURN_RATE = s.PITCH_RATE * 0.6;
  return (SPEC_CACHE[t] = s);
}
