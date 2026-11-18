var AgentHudBots = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/entry.ts
  var entry_exports = {};
  __export(entry_exports, {
    mount: () => mount
  });

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-state.ts
  var BOT_EVENT_FRESHNESS = 3;
  var BOT_SIGNS = [
    "exclamation",
    "question",
    "lines",
    "cross",
    "hourglass",
    "ellipsis",
    "z"
  ];
  function botState(value = {}) {
    return {
      look: "idle",
      subagents: false,
      badge: null,
      hovered: false,
      holds: false,
      card: "done",
      facing: null,
      ...value
    };
  }
  var isAttention = (look) => look === "permission" || look === "question" || look === "plan";
  var isWorking = (look) => look === "compacting" || look === "thinking" || look.startsWith("tool-") || look === "plain";
  var isCalm = (look) => look === "no-news" || look === "idle" || look === "asleep";
  var staysInPlace = (look) => isWorking(look) || isCalm(look);
  var eventRank = (event) => ({ start: 0, "limit-hit": 1, failed: 2 })[event];
  var badgeSign = (badge) => badge === "failed" ? "cross" : "hourglass";
  function shownSign(one, other) {
    if (!one || !other) return one ?? other;
    return BOT_SIGNS.indexOf(one) <= BOT_SIGNS.indexOf(other) ? one : other;
  }
  function stillSign(state) {
    const sign = state.look === "permission" ? "exclamation" : state.look === "question" ? "question" : state.look === "plan" ? "lines" : null;
    return shownSign(sign, state.badge ? badgeSign(state.badge) : null);
  }
  function botPhaseState(phase) {
    return botState(
      phase === "working" ? { look: "plain" } : phase === "asking" ? { look: "permission" } : phase === "done" ? { look: "done" } : phase === "opened" ? { hovered: true } : {}
    );
  }
  function facingAim(facing) {
    return { left: [-0.6, 0], right: [0.6, 0], up: [0, -0.6], down: [0, 0.6] }[facing];
  }
  function sameBotState(one, other) {
    return one.look === other.look && one.subagents === other.subagents && one.badge === other.badge && one.hovered === other.hovered && one.holds === other.holds && one.card === other.card && one.facing === other.facing;
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-moves.ts
  var easeInOut = (x) => x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
  var easeOut = (x) => 1 - (1 - x) ** 3;
  var easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
  var BotMoves = {
    ponderGaze: [0.4, -0.7],
    ponderTilt: 5,
    ponder: 2.5,
    ponderSide: (now) => Math.floor(now / 2.5 + 1e-6) % 2 === 0 ? 1 : -1,
    nextPonder: (now) => (Math.floor(now / 2.5 + 1e-6) + 1) * 2.5,
    beat: 0.125,
    burst: 3,
    cycle: 4.5,
    busySpin: 14,
    inBurst: (time) => Math.max(0, time) % 4.5 < 3 - 1e-6,
    bob(time) {
      return this.inBurst(time) && Math.floor(Math.max(0, time) / 0.125 + 1e-6) % 2 === 1 ? 0.04 : 0;
    },
    nextBob(time) {
      time = Math.max(0, time);
      return this.inBurst(time) ? (Math.floor(time / 0.125 + 1e-6) + 1) * 0.125 : (Math.floor(time / 4.5 + 1e-6) + 1) * 4.5;
    },
    fullWait: 8,
    firstMove: 1.2,
    move(age) {
      const first = 1.2, often = 2.6, rarely = 8;
      if (age < first) return { index: -1, start: null, next: first };
      const frequent = Math.ceil((120 - first) / often), late = first + frequent * often;
      if (age < late - 1e-9) {
        const index2 = Math.floor((age - first) / often + 1e-9);
        return {
          index: index2,
          start: first + index2 * often,
          next: first + (index2 + 1) * often
        };
      }
      const index = Math.floor((age - late) / rarely + 1e-9);
      return {
        index: frequent + index,
        start: late + index * rarely,
        next: late + (index + 1) * rarely
      };
    },
    moveLength: (look) => look === "question" ? 0.4 : look === "plan" ? 0.6 : 0.55,
    knock(time) {
      return time >= 0 && time < 0.55 ? 8 * Math.sin(2 * Math.PI * 2.5 * time / 0.55) * (1 - time / 0.55) : 0;
    },
    questionTilt(age) {
      const move = this.move(age);
      if (move.start === null) return 0;
      const side = move.index % 2 === 0 ? 1 : -1, from = move.index === 0 ? 0 : -12 * side, x = Math.min(1, (age - move.start) / 0.4);
      return from + (12 * side - from) * easeInOut(x);
    },
    nod(time) {
      if (time < 0 || time >= 0.6) return 0;
      const half = time / 0.3;
      return 0.03 * Math.sin(Math.PI * (half - Math.floor(half)));
    },
    hopSeconds: 0.3,
    length: (event, limbed) => event === "start" ? limbed ? 1 : 0.3 : event === "failed" ? 1.5 : limbed ? 1 : 1.2,
    hop(time) {
      if (time < 0 || time >= 0.3) return 0;
      const x = time / 0.3;
      return -0.06 * 4 * x * (1 - x);
    },
    shake: (time) => time >= 0 && time < 0.5 ? 0.05 * Math.sin(2 * Math.PI * 6 * time) * (1 - time / 0.5) : 0,
    sag: (time) => time < 0.5 ? 0 : time < 0.75 ? easeInOut((time - 0.5) / 0.25) : time < 1.2 ? 1 : time < 1.5 ? 1 - easeInOut((time - 1.2) / 0.3) : 0,
    sigh(time) {
      const u = Math.max(0, time) / 1.2;
      if (u < 0.4) {
        const k2 = easeInOut(u / 0.4);
        return { scaleX: 1 - 0.04 * k2, scaleY: 1 + 0.07 * k2, open: 1 - 0.7 * k2 };
      }
      if (u < 0.7) {
        const k2 = easeInOut((u - 0.4) / 0.3);
        return {
          scaleX: 0.96 + 0.1 * k2,
          scaleY: 1.07 - 0.15 * k2,
          open: 0.3 + 0.2 * k2
        };
      }
      const k = easeInOut(Math.min(1, (u - 0.7) / 0.3));
      return {
        scaleX: 1.06 - 0.06 * k,
        scaleY: 0.92 + 0.08 * k,
        open: 0.5 + 0.5 * k
      };
    },
    paddle: 14,
    finWaveSeconds: 0.9,
    cheerStart: 0.3,
    cheerSeconds: 1.2,
    finFlap: (time) => time >= 0 && time < 0.3 ? 32 * Math.sin(Math.PI * time / 0.3) : 0,
    finWave(time) {
      if (time < 0 || time >= 0.9) return 0;
      const up = easeInOut(Math.min(1, time / 0.18)) * easeInOut(Math.min(1, (0.9 - time) / 0.18));
      return up * (34 + 12 * Math.sin(2 * Math.PI * (time - 0.18) / 0.27));
    },
    cheer(age) {
      const time = age - 0.3;
      return time >= 0 && time < 1.2 ? 30 * Math.abs(Math.sin(Math.PI * time / 0.4)) : 0;
    }
  };

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-pace.ts
  var BotPace = {
    lively: 1 / 24,
    following: 1 / 12,
    calm: 1 / 6,
    slack: 4e-3,
    next: (now, pace) => (Math.floor((now + 4e-3) / pace) + 1) * pace,
    frame(time, now) {
      return Math.max(
        this.next(now, this.lively),
        Math.ceil((time - this.slack) / this.lively) * this.lively
      );
    },
    onFrame(now) {
      const frame = Math.round(now / this.lively) * this.lively;
      return Math.abs(frame - now) <= this.slack ? frame : now;
    }
  };
  var SplitMix = class {
    state;
    constructor(seed = BigInt(
      Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
    )) {
      this.state = BigInt.asUintN(64, BigInt(seed));
    }
    next() {
      this.state = BigInt.asUintN(64, this.state + 0x9e3779b97f4a7c15n);
      let z = this.state;
      z = BigInt.asUintN(64, (z ^ z >> 30n) * 0xbf58476d1ce4e5b9n);
      z = BigInt.asUintN(64, (z ^ z >> 27n) * 0x94d049bb133111ebn);
      return z ^ z >> 31n;
    }
    unit() {
      return Number(this.next() >> 11n) / 2 ** 53;
    }
  };

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-pose.ts
  var botPose = () => ({
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    footing: 0
  });
  function mixPose(a, b, t) {
    return Object.fromEntries(
      Object.keys(a).map((key) => [
        key,
        a[key] + (b[key] - a[key]) * t
      ])
    );
  }
  function sitting(motion, age, progress, swell, dozing) {
    const pose = botPose();
    if (isAttention(motion.look)) {
      if (age < 0.45) {
        const x = age / 0.45, arc = Math.sin(Math.PI * x);
        pose.y = -0.26 * 4 * x * (1 - x);
        pose.scaleY = 1 + 0.08 * arc;
        pose.scaleX = 1 - 0.05 * arc;
      }
      const raised = 1 + 0.12 * easeOutBack(Math.min(1, age / 0.35));
      pose.scaleX *= raised;
      pose.scaleY *= raised;
      if (!motion.turnsToCard) {
        const start = BotMoves.move(age).start;
        if (!motion.limbed) {
          if (motion.look === "permission")
            pose.rotation = start === null ? 0 : BotMoves.knock(age - start);
          if (motion.look === "question")
            pose.rotation = BotMoves.questionTilt(age);
          if (motion.look === "plan")
            pose.y += start === null ? 0 : BotMoves.nod(age - start);
        }
      }
    } else if (motion.look === "done") {
      if (age < 0.6) {
        const pop = Math.sin(Math.PI * age / 0.6);
        pose.scaleX = pose.scaleY = 1 + 0.2 * pop;
        pose.y = -0.1 * pop;
      }
    } else {
      if (motion.breathes(dozing)) {
        const breath = 2 * Math.PI * age / motion.period;
        pose.scaleX = 1 + 0.03 * Math.sin(2 * breath);
        pose.scaleY = 1 - 0.03 * Math.sin(2 * breath);
      }
      if (motion.look === "thinking" && !motion.limbed)
        pose.rotation = BotMoves.ponderTilt * Math.max(-1, Math.min(1, motion.face.look / BotMoves.ponderGaze[0]));
    }
    if (motion.act && !motion.limbed) {
      if (motion.act.kind === "tilt")
        pose.rotation += motion.act.side * 9 * swell;
      if (motion.act.kind === "stretch") {
        const arc = Math.sin(Math.PI * progress);
        pose.scaleY *= 1 + 0.06 * arc;
        pose.scaleX *= 1 - 0.04 * arc;
      }
      if (motion.act.kind === "wiggle")
        pose.rotation += 8 * Math.sin(2 * Math.PI * 3 * progress) * (1 - progress);
    }
    return pose;
  }
  function played(motion, now) {
    if (motion.greeting !== null)
      motion.pose.y += BotMoves.hop(now - motion.greeting) * motion.morph;
    if (!motion.event) return;
    const time = now - motion.event.start;
    if (motion.event.kind === "start")
      motion.pose.y += BotMoves.hop(time) * motion.morph;
    else if (motion.event.kind === "failed") {
      const sag = BotMoves.sag(time);
      motion.pose.x += BotMoves.shake(time) * motion.morph;
      motion.pose.rotation += 6 * sag * motion.morph;
      motion.pose.y += 0.02 * sag * motion.morph;
    } else {
      const sigh = BotMoves.sigh(time);
      motion.pose.scaleX *= 1 + (sigh.scaleX - 1) * motion.morph;
      motion.pose.scaleY *= 1 + (sigh.scaleY - 1) * motion.morph;
      motion.pose.footing = 0.5;
    }
  }
  function flapping(motion, age, now) {
    let left = 0, right = 0;
    if (motion.event) {
      left = right = motion.event.kind === "start" ? BotMoves.finFlap(now - motion.event.start) * motion.morph : 0;
    } else if (motion.greeting !== null) {
      const wave = BotMoves.finWave(now - motion.greeting) * motion.morph;
      if (motion.greetSide < 0 || motion.helper) left = wave;
      else right = wave;
    } else if (motion.look.startsWith("tool-") && !motion.state.holds)
      left = right = BotMoves.bob(now - motion.beatsFrom) > 0 ? BotMoves.paddle * motion.morph : 0;
    else if (motion.look === "done")
      left = right = BotMoves.cheer(age) * motion.morph;
    return { left: Math.round(left), right: Math.round(right) };
  }
  function keep(motion, age, now, dt) {
    if (staysInPlace(motion.look)) {
      motion.kept = { lift: 0, scale: 1 };
      return;
    }
    let lift = 0, scale = 1;
    if (isAttention(motion.look)) {
      lift = 0.03;
      scale = 1.22;
      if (!motion.turnsToCard && (age < BotMoves.fullWait || motion.moving(age)))
        scale += 0.08 * Math.sin(2 * Math.PI * now / 0.8);
    } else if (motion.look === "done" && age < 0.6)
      lift = 0.22 * Math.sin(Math.PI * age / 0.6);
    const ease = 1 - Math.exp(-dt * 22);
    motion.kept.lift += (lift - motion.kept.lift) * ease;
    motion.kept.scale += (scale - motion.kept.scale) * ease;
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-face.ts
  var botFace = () => ({
    open: 1,
    look: 0,
    lookY: 0,
    wide: 1,
    happy: 0,
    lean: 0,
    crossed: 0
  });
  function updateFace(motion, age, now, dt, aim, swell, dozing) {
    const target = botFace();
    let every = [3.2, 6.5];
    if (isAttention(motion.look)) {
      target.wide = 1.22;
      if (motion.state.facing) {
        const a = facingAim(motion.state.facing);
        target.look = a[0];
        target.lookY = a[1];
      } else if (motion.state.hovered) {
        target.look = aim[0];
        target.lookY = aim[1];
      }
      if (motion.look === "plan" && motion.moving(age)) target.lookY = 0.5;
      every = age < 1.5 || age >= BotMoves.fullWait || motion.turnsToCard ? null : [4, 7];
    } else if (motion.look === "done") {
      if (age < 1.25) {
        target.happy = 1;
        every = null;
      } else {
        target.look = aim[0];
        target.lookY = aim[1];
      }
    } else if (motion.look === "thinking" && !motion.state.hovered) {
      const side = motion.state.holds ? motion.heldSide : BotMoves.ponderSide(now);
      target.look = BotMoves.ponderGaze[0] * side;
      target.lookY = BotMoves.ponderGaze[1];
      every = [2.2, 4.5];
    } else if (dozing || motion.look === "compacting" && motion.limbed) {
      target.open = 0;
      every = null;
    } else {
      target.look = aim[0];
      target.lookY = aim[1];
      every = [2.2, 4.5];
      const act = motion.act;
      if (act) {
        if (act.kind === "glance") {
          target.look += (act.gaze[0] * 0.8 - target.look) * swell;
          target.lookY += (act.gaze[1] - target.lookY) * swell;
        }
        if (act.kind === "squint") target.open = 1 - 0.55 * swell;
        if (act.kind === "widen" || act.kind === "hop")
          target.wide = 1 + 0.2 * swell;
        if (act.kind === "smile") target.happy = swell > 0.4 ? 1 : 0;
        if (act.kind === "inspect") {
          target.lean = act.side * swell;
          target.look += (act.side * 0.6 - target.look) * swell;
          target.lookY -= target.lookY * swell;
        }
        if (act.kind === "stretch" && motion.limbed)
          target.open = 1 - 0.9 * swell;
      }
    }
    if (motion.state.holds) every = null;
    if (motion.pending?.kind === "start") target.open = 0;
    if (motion.event) {
      const time = now - motion.event.start;
      if (motion.event.kind === "start")
        target.open = Math.min(1, time / BotMoves.hopSeconds);
      else if (motion.event.kind === "failed") {
        if (motion.crossesEyes) target.crossed = 1;
        else target.open = 0.45;
        target.lookY = 0.35 * BotMoves.sag(time);
      } else {
        target.open = motion.limbed ? time < 4 * BotMoves.beat ? 0 : 0.5 : BotMoves.sigh(time).open;
        target.lookY = 0.3;
      }
      every = null;
    }
    motion.blinksOn = every !== null;
    const eyes2 = 1 - Math.exp(-dt * 18), head = 1 - Math.exp(-dt * 9);
    motion.face.look += (target.look - motion.face.look) * head;
    motion.face.lookY += (target.lookY - motion.face.lookY) * head;
    for (const key of ["wide", "happy", "lean", "crossed"])
      motion.face[key] += (target[key] - motion.face[key]) * eyes2;
    let lid = target.open;
    if (every) {
      if (now >= motion.nextBlink) {
        motion.blinks = [now, -1];
        motion.nextBlink = now + every[0] + motion.random.unit() * (every[1] - every[0]);
      }
    } else if (motion.nextBlink < now) motion.nextBlink = now + 1.2;
    for (const start of motion.blinks) {
      const blink = (now - start) / 0.17;
      if (blink >= 0 && blink < 1) lid *= 1 - Math.sin(Math.PI * blink);
    }
    motion.face.open += (lid - motion.face.open) * (1 - Math.exp(-dt * 60));
    motion.blinking = Math.abs(lid - motion.face.open) > 0.01 || motion.blinks.some((start) => now >= start && now - start < 0.17);
    motion.following = Math.abs(target.look - motion.face.look) > 4e-3 || Math.abs(target.lookY - motion.face.lookY) > 4e-3 || Math.abs(target.wide - motion.face.wide) > 4e-3 || Math.abs(target.happy - motion.face.happy) > 0.01 || Math.abs(target.lean - motion.face.lean) > 0.01 || Math.abs(target.crossed - motion.face.crossed) > 0.01;
  }
  function signs(motion, now, arrived, dozing) {
    let sign = arrived ? stillSign(motion.state) : motion.state.badge ? badgeSign(motion.state.badge) : null;
    if (motion.event?.kind === "failed") sign = shownSign(sign, "cross");
    if (motion.morph > 0 && motion.look === "thinking" && !motion.limbed)
      sign = shownSign(sign, "ellipsis");
    if (motion.morph > 0 && dozing) sign = shownSign(sign, "z");
    motion.sign = sign;
    motion.lit = sign === "ellipsis" && !motion.state.holds ? Math.floor(now * 3 + 1e-6) % 3 : 0;
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-stance.ts
  var botLimbs = () => ({
    left: 0,
    right: 0,
    lifted: 0,
    x: 0,
    y: 0,
    spinner: 0
  });
  var hopPath = [
    [1, 3, 0],
    [-2, 0, 1],
    [-3, 0, 2],
    [-3, 0, 2],
    [-2, 0, 1],
    [0, 0, 0],
    [1, 3, 0],
    [0, 0, 0]
  ];
  function stance(motion, age, now, dozing) {
    if (motion.event)
      return eventStance(motion.event.kind, now - motion.event.start);
    const limbs = botLimbs(), beat = (seconds, every) => Math.floor(Math.max(0, seconds) / every + 1e-6), clock2 = now - motion.beatsFrom;
    if (motion.look === "thinking" || motion.look.startsWith("tool-") || motion.look === "plain") {
      if (!motion.sign) {
        const frame2 = motion.state.holds ? 0 : beat(now, BotMoves.beat) % 10;
        limbs.spinner = frame2 < 6 ? frame2 + 1 : 11 - frame2;
      }
      if (motion.look !== "thinking" && !motion.state.holds && BotMoves.inBurst(clock2)) {
        const tap = beat(clock2, BotMoves.beat);
        limbs.left = tap % 2;
        limbs.right = 1 - limbs.left;
        limbs.y = Math.floor(tap / 2) % 2;
      }
    } else if (motion.look === "compacting") {
      limbs.left = limbs.right = 1;
      limbs.lifted = 3;
    } else if (motion.turnsToCard) {
      if (motion.state.facing === "left") limbs.left = 2;
      else if (motion.state.facing === "right") limbs.right = 2;
    } else if (isAttention(motion.look)) {
      const move = BotMoves.move(age), into = move.start === null ? null : age - move.start;
      if (age < BotMoves.firstMove || motion.moving(age)) {
        limbs.left = 1 + beat(clock2, BotMoves.beat) % 2;
        limbs.right = 3 - limbs.left;
        if (into !== null && beat(into, BotMoves.beat) % 2 === 0) {
          limbs.y = -2;
          limbs.lifted = 3;
        }
      } else limbs.right = 2;
    } else if (motion.look === "done" && age < 1.5) {
      const step = beat(clock2, 2 * BotMoves.beat);
      limbs.left = step % 2 === 0 ? 2 : 0;
      limbs.right = 2 - limbs.left;
      if (step % 2 === 1) {
        limbs.y = -2;
        limbs.lifted = 3;
      }
    } else if (motion.look === "asleep" && dozing) {
      limbs.lifted = 3;
      limbs.y = 1;
    }
    const act = motion.act;
    if (!act || !staysInPlace(motion.look)) return limbs;
    const since = now - act.start, ending = since > act.length - 0.15, frame = (count) => Math.min(count - 1, beat(since, act.length / count));
    if (["wave", "scuttle", "hop", "stretch"].includes(act.kind))
      limbs.left = limbs.right = limbs.y = 0;
    if (act.kind === "wave") {
      if (since < 0.24) limbs.y = -1;
      const arm = since < 0.12 || ending ? 1 : 2 - beat(since - 0.12, 0.16) % 2;
      if (act.side < 0) limbs.left = arm;
      else limbs.right = arm;
    }
    if (act.kind === "scuttle") {
      const path = [0, 1, 2, 1, 0, -1, -2, -1, 0], step = frame(path.length);
      limbs.x = path[step] * (act.side < 0 ? -1 : 1);
      limbs.lifted = step === 0 || step === path.length - 1 ? 0 : 1 + step % 2;
    }
    if (act.kind === "hop") {
      const at = hopPath[frame(hopPath.length)];
      limbs.y = at[0];
      limbs.lifted = at[1];
      limbs.left = limbs.right = at[2];
    }
    if (act.kind === "stretch" && since > 0.15 && !ending) {
      limbs.left = limbs.right = 2;
      limbs.y = -1;
    }
    return limbs;
  }
  function eventStance(event, time) {
    const limbs = botLimbs(), beat = (every) => Math.floor(Math.max(0, time) / every + 1e-6);
    if (event === "start") {
      const at = hopPath[Math.min(hopPath.length - 1, beat(BotMoves.beat))];
      limbs.y = at[0];
      limbs.lifted = at[1];
      limbs.left = limbs.right = at[2];
    } else if (event === "failed") {
      if (time < 0.5) limbs.x = beat(1 / 12) % 2 === 0 ? 1 : -1;
      else {
        limbs.y = 1;
        limbs.lifted = 3;
      }
    } else if (time < 4 * BotMoves.beat) {
      limbs.left = limbs.right = 2;
      limbs.y = -1;
    } else {
      limbs.y = 1;
      limbs.lifted = 3;
    }
    return limbs;
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-acts.ts
  function pick(motion, now) {
    let pool = [
      ["glance", 5],
      ["blink-twice", 2],
      ["squint", 2],
      ["widen", 2],
      ["smile", 2],
      ["inspect", 2],
      ["tilt", 3],
      ["stretch", 2],
      ["wiggle", 2]
    ];
    if (motion.spin !== 0) pool.push(["turn", 3]);
    if (motion.limbed) {
      pool = pool.filter(([kind2]) => kind2 !== "tilt" && kind2 !== "wiggle");
      if (motion.state.hovered)
        pool.push(["wave", 4], ["hop", 2], ["scuttle", 2]);
      else if (isWorking(motion.look))
        pool.push(["scuttle", 4], ["hop", 3], ["wave", 1]);
      else if (isCalm(motion.look))
        pool = [
          ["scuttle", 3],
          ["hop", 3],
          ["stretch", 3],
          ["wave", 2]
        ];
    }
    let roll = motion.random.unit() * pool.reduce((a, b) => a + b[1], 0), kind = pool[0][0];
    for (const [candidate, weight] of pool) {
      roll -= weight;
      if (roll < 0) {
        kind = candidate;
        break;
      }
    }
    if (motion.greets) {
      motion.greets = false;
      if (motion.greetsOnHover) kind = "wave";
    }
    const lengths = {
      glance: 0,
      "blink-twice": 0.5,
      squint: 1.2,
      widen: 0.9,
      smile: 1.1,
      inspect: 1.5,
      tilt: 1.1,
      stretch: 0.55,
      wiggle: 0.6,
      turn: 0.7,
      wave: 1.4,
      scuttle: 1.1,
      hop: 0.8
    }, length = kind === "glance" ? 1.1 + motion.random.unit() * 0.7 : lengths[kind], angle = motion.random.unit() * 2 * Math.PI;
    return {
      kind,
      start: now,
      length,
      side: motion.random.unit() < 0.5 ? -1 : 1,
      gaze: [Math.cos(angle), Math.sin(angle) * 0.7],
      from: motion.turn
    };
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-motion.ts
  var BotMotion = class {
    staysBot = false;
    arrivesAfter = 0;
    period = 3;
    spin = 0;
    limbed = false;
    stepShare = 0;
    crossesEyes = false;
    pulses = false;
    finned = false;
    state = botState();
    since = -10;
    morph = 0;
    face = botFace();
    pose = botPose();
    turn = 0;
    kept = { lift: 0, scale: 1 };
    limbs = botLimbs();
    flap = { left: 0, right: 0 };
    sign = null;
    lit = 0;
    opacity = 1;
    wait = BotPace.lively;
    last = null;
    leaving = null;
    act = null;
    nextAct = 0;
    blinks = [-1, -1];
    nextBlink = 2;
    following = false;
    blinking = false;
    blinksOn = true;
    botInterval = null;
    greets = false;
    greetAfter = null;
    greeting = null;
    greetSide = 1;
    pending = null;
    event = null;
    beatsFrom = 0;
    heldSide = 1;
    settled = false;
    random;
    constructor(seed) {
      this.random = new SplitMix(seed);
    }
    fit(spec2) {
      this.spin = spec2.spin ?? 0;
      this.limbed = Boolean(spec2.limbs);
      this.stepShare = spec2.limbs ? spec2.limbs.pixel / 2 * spec2.radius : 0;
      this.crossesEyes = Boolean(spec2.crossesEyes);
      this.pulses = Boolean(spec2.keeps);
      this.finned = Boolean(
        spec2.decor?.some(
          (item) => item.kind === "fins" && item.fins?.some((fin) => fin.hand !== 0)
        )
      );
    }
    get look() {
      return this.state.look;
    }
    get helper() {
      return this.state.subagents && isWorking(this.look);
    }
    get isAtRest() {
      if (this.pending || this.event || this.greeting !== null) return false;
      if (this.settled) return true;
      if (this.morph !== 0 || this.staysBot || this.state.hovered) return false;
      if (this.look === "idle" || this.look === "asleep")
        return this.botInterval === null && this.poseIsRest();
      if (this.look === "no-news") return this.poseIsRest();
      return this.look === "done" && (this.last ?? 0) - this.since > 2.4;
    }
    poseIsRest() {
      const p = this.pose;
      return p.x === 0 && p.y === 0 && p.rotation === 0 && p.scaleX === 1 && p.scaleY === 1 && p.footing === 0;
    }
    set(next, now) {
      if (typeof next === "string") next = botPhaseState(next);
      const before = this.state;
      this.state = { ...next };
      this.settled = false;
      if (next.holds && !before.holds) this.heldSide = BotMoves.ponderSide(now);
      if (next.look !== before.look) {
        this.leaving = { ...this.pose };
        this.since = now + (this.staysBot && this.morph === 0 ? Math.max(0, this.arrivesAfter) : 0);
        this.beatsFrom = Math.ceil((this.since - BotPace.slack) / BotMoves.beat) * BotMoves.beat;
        if (isWorking(next.look))
          this.nextAct = now + 0.9 + this.random.unit() * 1.2;
        this.botInterval = null;
      }
      if (next.hovered !== before.hovered) this.hover(next.hovered, now);
      if (this.visits && this.botInterval === null)
        this.scheduleVisit(now + this.morph * 0.5);
    }
    play(next, now) {
      if (this.pending && eventRank(this.pending.kind) > eventRank(next)) return;
      this.pending = { kind: next, asked: now };
      this.settled = false;
    }
    resume(now) {
      if (!isWorking(this.look) && !isAttention(this.look)) return;
      this.morph = 1;
      this.leaving = null;
      this.since = now - (isAttention(this.look) ? BotMoves.firstMove : 0.3);
      this.beatsFrom = Math.ceil((this.since - BotPace.slack) / BotMoves.beat) * BotMoves.beat;
    }
    step(time, aim = [0, 0]) {
      const now = BotPace.onFrame(time), gap = Math.max(0, now - (this.last ?? now)), dt = gap > 1 / 3 ? 0 : Math.min(1 / 6, gap);
      this.last = now;
      const age = now - this.since;
      if (this.visits && this.botInterval && now >= this.botInterval[1])
        this.scheduleVisit(now + 0.5);
      const visiting = this.visits && this.botInterval !== null && now >= this.botInterval[0] && now < this.botInterval[1], dozing = this.look === "asleep" && !this.state.hovered, arrived = age >= 0;
      if (this.pending && now - this.pending.asked > BOT_EVENT_FRESHNESS)
        this.pending = null;
      if (this.event && now - this.event.start >= BotMoves.length(this.event.kind, this.limbed))
        this.event = null;
      const awake = arrived && (isWorking(this.look) || isAttention(this.look) || visiting || this.state.hovered || this.look === "done" && age < 1.5 || this.pending !== null || this.event !== null), wanted = arrived && (awake || this.staysBot) ? 1 : 0, stride = dt / 0.5;
      this.morph = Math.abs(wanted - this.morph) <= stride ? wanted : this.morph + (wanted > this.morph ? stride : -stride);
      this.opacity = this.look === "no-news" ? 0.5 + 0.5 * this.morph : 1;
      if (this.pending && !this.event && !isAttention(this.look) && this.morph > 0.9) {
        this.event = { kind: this.pending.kind, start: now };
        this.pending = null;
        this.act = null;
      }
      if (this.greetAfter !== null && now >= this.greetAfter && this.morph > 0.9 && !this.event && !this.pending) {
        this.greetAfter = null;
        if (this.greetsOnHover) {
          this.greeting = now;
          this.greetSide = aim[0] < 0 ? -1 : 1;
        }
      }
      if (this.greeting !== null && now - this.greeting >= (this.finned ? Math.max(BotMoves.hopSeconds, BotMoves.finWaveSeconds) : BotMoves.hopSeconds))
        this.greeting = null;
      if (this.act && now - this.act.start >= this.act.length) {
        if (this.act.kind === "turn")
          this.turn = this.act.from + 60 * this.act.side;
        this.act = null;
      }
      const inPlace = staysInPlace(this.look);
      if (inPlace && this.acts) {
        if ((awake || this.staysBot) && this.morph > 0.9 && !this.act && now >= this.nextAct) {
          const chosen = pick(this, now);
          if (chosen.kind === "wave" && aim[0] !== 0)
            chosen.side = aim[0] > 0 ? 1 : -1;
          this.act = chosen;
          this.nextAct = now + chosen.length + 0.5 + this.random.unit() * 1.9;
          if (chosen.kind === "blink-twice") this.blinks = [now, now + 0.24];
        }
      } else this.act = null;
      const progress = this.act ? (now - this.act.start) / this.act.length : 0, swell = this.act ? easeInOut(
        Math.min(1, Math.min(progress / 0.22, (1 - progress) / 0.22))
      ) : 0;
      if (inPlace && this.morph > 0.5 && this.spin !== 0)
        this.turn = this.act?.kind === "turn" ? this.act.from + 60 * this.act.side * easeInOut(progress) : this.turn + this.spinRate(now, dozing) * dt;
      signs(this, now, arrived, dozing);
      this.pose = arrived ? sitting(this, age, progress, swell, dozing) : botPose();
      if (this.leaving && arrived && age < 0.3)
        this.pose = mixPose(this.leaving, this.pose, easeOut(age / 0.3));
      if (inPlace) {
        this.pose = mixPose(botPose(), this.pose, this.morph);
        this.pose.x = 0;
        this.pose.y = 0;
        this.pose.footing = 0;
        if (!this.limbed && this.look.startsWith("tool-") && !this.state.holds)
          this.pose.y = BotMoves.bob(now - this.beatsFrom) * this.morph;
      } else if (this.morph > 0.5) this.pose.x += 0.025 * this.face.look;
      if (!this.limbed) played(this, now);
      this.limbs = this.limbed && arrived ? stance(this, age, now, dozing) : botLimbs();
      this.flap = this.finned && arrived ? flapping(this, age, now) : { left: 0, right: 0 };
      this.pose.x += this.limbs.x * this.stepShare * this.morph;
      this.pose.y += this.limbs.y * this.stepShare * this.morph;
      if (arrived && (!inPlace || this.morph > 0))
        updateFace(this, age, now, dt, aim, swell, dozing);
      else this.following = this.blinking = false;
      if (arrived) keep(this, age, now, dt);
      const stills = this.state.holds && isWorking(this.look) || this.turnsToCard && age >= 0.45;
      this.settled = stills && !this.state.hovered && this.morph === wanted && !this.following && !this.blinking && !this.act && !this.event && !this.pending && this.greeting === null;
      const wait = this.nextFrame(now, age, wanted, dozing);
      this.wait = wait === null ? null : wait + now - time;
    }
    nextFrame(now, age, wanted, dozing) {
      if (this.isAtRest) return null;
      const at = (time) => BotPace.frame(time, now) - now, every = (pace2) => BotPace.next(now, pace2) - now;
      if (age < 0) return at(this.since);
      if (this.morph === 0 && wanted === 0) {
        if (this.visits && this.botInterval) return at(this.botInterval[0]);
        if (this.look === "done") return at(this.since + 2.41);
        return every(BotPace.lively);
      }
      if (this.morph !== wanted || this.act || this.blinking || age < 0.3 || this.event || this.pending || this.greeting !== null)
        return every(BotPace.lively);
      let pace = this.following ? BotPace.following : this.breathes(dozing) || this.spinRate(now, dozing) !== 0 ? BotPace.calm : null, next = Infinity;
      if (this.blinksOn) next = Math.min(next, this.nextBlink);
      if (this.acts) next = Math.min(next, this.nextAct);
      if (this.greetAfter !== null) next = Math.min(next, this.greetAfter);
      if (this.visits && this.botInterval)
        next = Math.min(next, this.botInterval[1]);
      if (this.turnsToCard) {
        if (age < 0.45) return every(BotPace.lively);
      } else if (isAttention(this.look)) {
        if (age < BotMoves.firstMove || this.moving(age))
          return every(BotPace.lively);
        if (this.pulses && age < BotMoves.fullWait) pace = BotPace.following;
        next = Math.min(next, this.since + BotMoves.move(age).next);
      } else if (this.look === "done") {
        if (age < 1.5) return every(BotPace.lively);
      } else if (this.look.startsWith("tool-") && !this.limbed && !this.state.holds) {
        if (BotMoves.inBurst(now - this.beatsFrom))
          pace = this.following ? BotPace.following : null;
        next = Math.min(
          next,
          this.beatsFrom + BotMoves.nextBob(now - this.beatsFrom)
        );
      } else if (this.look === "thinking" && !this.state.holds && !this.state.hovered) {
        next = Math.min(next, BotMoves.nextPonder(now));
        if (this.sign === "ellipsis")
          next = Math.min(next, (Math.floor(now * 3 + 1e-6) + 1) / 3);
      }
      if (this.limbed && this.stanceBeats)
        next = Math.min(next, BotPace.next(now, BotMoves.beat));
      const byPace = pace === null ? null : every(pace), byTime = Number.isFinite(next) ? at(next) : null;
      return byPace === null ? byTime : Math.min(byPace, byTime ?? byPace);
    }
    get visits() {
      return !this.staysBot && !this.state.hovered && (this.look === "idle" || this.look === "asleep");
    }
    get acts() {
      if (this.event || this.greeting !== null || this.state.holds) return false;
      if (this.state.hovered) return staysInPlace(this.look);
      return this.look === "plain" || this.look.startsWith("tool-") || this.look === "idle" || this.look === "no-news";
    }
    get greetsOnHover() {
      return this.state.hovered && !isAttention(this.look) && (isCalm(this.look) || this.state.badge !== null);
    }
    get turnsToCard() {
      return this.state.facing !== null && isAttention(this.look);
    }
    breathes(dozing) {
      return !this.limbed && staysInPlace(this.look) && !this.state.holds && !dozing;
    }
    spinRate(now, dozing) {
      if (this.spin === 0 || !staysInPlace(this.look) || this.morph <= 0.5 || this.state.holds || dozing)
        return 0;
      return this.look.startsWith("tool-") ? BotMoves.inBurst(now - this.beatsFrom) ? BotMoves.busySpin : 0 : this.spin;
    }
    moving(age) {
      const start = BotMoves.move(age).start;
      return !this.turnsToCard && start !== null && age - start < BotMoves.moveLength(this.look);
    }
    hover(on, now) {
      this.greetAfter = null;
      this.botInterval = null;
      if (!on) {
        this.greets = false;
        return;
      }
      if (this.limbed) {
        this.greets = true;
        this.act = null;
        this.nextAct = now;
      } else {
        this.greetAfter = now + BotMoves.hopSeconds;
        this.nextAct = now + 0.9 + this.random.unit() * 1.2;
      }
    }
    scheduleVisit(now) {
      const start = now + (this.look === "asleep" ? 180 + this.random.unit() * 120 : 20 + this.random.unit() * 15);
      this.botInterval = [start, start + 3 + this.random.unit() * 2 - 0.5];
      this.nextAct = start + 0.5;
    }
    get stanceBeats() {
      return !this.state.holds && (this.look.startsWith("tool-") || this.look === "plain" || this.look === "thinking" && this.sign === null);
    }
  };

  // ../ext-hud/repo/src/packages/hud/src/bots/clawd-clips.ts
  var CLAWD_FPS = 12;
  var frameAfter = (time) => Math.ceil((time - 4e-3) * CLAWD_FPS) / CLAWD_FPS;
  var clawdTicks = (seconds) => Math.max(1, swiftRound(seconds * CLAWD_FPS));
  var swiftRound = (value) => Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
  var zeroOffset = { x: 0, y: 0 };
  var standing = { name: "Walking", index: 0 };
  var sameFrame = (one, other) => one == null || other == null ? one == null && other == null : one.name === other.name && one.index === other.index;
  function easedOffset(offset, share) {
    const ease = easeInOut(Math.max(0, Math.min(1, share)));
    return { x: swiftRound(offset.x * ease), y: swiftRound(offset.y * ease) };
  }
  var isClawdAttention = (look) => look === "permission" || look === "question" || look === "plan";
  var numbers = (first, last) => Array.from({ length: last - first + 1 }, (_, at) => first + at);
  var frames = (name, first, last = first) => numbers(first, last).map((index) => ({ name, index }));
  var clip = (sprite, value) => ({
    sprite,
    intro: [],
    outro: [],
    ticks: 1,
    offset: zeroOffset,
    exit: { kind: "cycle-end" },
    pace: { kind: "steady" },
    working: false,
    ...value
  });
  function shot(all, options = {}) {
    const main = all[0]?.name, {
      sign,
      signDuring,
      hold,
      offset = zeroOffset,
      easeIn = 0,
      easeOut: easeOut2 = 0
    } = options;
    return {
      steps: all.map((frame, at) => {
        const signed = signDuring ? frame.name === main && frame.index >= signDuring[0] && frame.index <= signDuring[1] : true;
        let share = at < easeIn ? at / easeIn : 1;
        if (at >= all.length - easeOut2)
          share = Math.min(share, (all.length - 1 - at) / Math.max(1, easeOut2));
        return {
          frame,
          ticks: hold && sameFrame(hold.frame, frame) ? clawdTicks(hold.seconds) : 1,
          sign: signed ? sign : void 0,
          offset: easedOffset(offset, share)
        };
      })
    };
  }
  var longRun = { kind: "resting", after: 20, hold: 3 };
  var longWait = {
    kind: "waiting",
    after: 8,
    every: 2.6,
    slowAfter: 120,
    slowEvery: 8
  };
  var thinking = clip("Thinking", {
    name: "thinking",
    intro: frames("Thinking", 4, 5),
    loop: numbers(6, 19),
    outro: [...frames("Thinking", 5), ...frames("Thinking", 4), standing],
    pace: longRun,
    working: true,
    miniShift: 13
  });
  var laptop = clip("Laptop", {
    name: "laptop",
    intro: frames("Laptop", 14, 16),
    loop: numbers(17, 33),
    outro: frames("Laptop", 34, 42),
    offset: { x: -1, y: 0 },
    pace: longRun,
    working: true,
    miniShift: -14
  });
  var desktop = clip("Desktop", {
    name: "desktop",
    intro: frames("Desktop", 3, 15),
    entry: frames("Desktop", 7, 15),
    loop: numbers(16, 75),
    outro: frames("Desktop", 76, 87),
    exit: { kind: "any-frame" },
    offset: { x: -3, y: 0 },
    pace: longRun,
    working: true
  });
  var reading = clip("LookingAround", {
    name: "reading",
    loop: numbers(6, 15),
    ticks: 2,
    pace: longRun,
    working: true,
    miniShift: 13
  });
  var meditating = clip("Meditating", {
    name: "meditating",
    intro: frames("Meditating", 6, 13),
    loop: numbers(23, 34),
    outro: frames("Meditating", 45, 54),
    exit: { kind: "through", frame: 23 }
  });
  var pointing = clip("Pointing", {
    name: "pointing",
    intro: frames("Pointing", 6, 18),
    loop: numbers(19, 23),
    outro: [...frames("Pointing", 18), standing],
    exit: { kind: "any-frame" },
    sign: "exclamation",
    pace: longWait
  });
  var waving = clip("Waving", {
    name: "waving",
    intro: frames("Waving", 3, 6),
    loop: numbers(7, 8),
    outro: [...frames("Waving", 6), standing],
    exit: { kind: "through", frame: 8 },
    sign: "question",
    pace: longWait
  });
  var lightbulb = clip("Lightbulb", {
    name: "lightbulb",
    intro: frames("Lightbulb", 4, 10),
    loop: numbers(11, 38),
    outro: frames("Lightbulb", 41, 44),
    exit: { kind: "any-frame" },
    offset: { x: 0, y: 1 },
    pace: {
      kind: "replaying",
      after: 120,
      hold: 11,
      replay: numbers(26, 29),
      every: 8
    }
  });
  var clawdClips = {
    looks: {
      thinking,
      retrying: thinking,
      edit: laptop,
      command: laptop,
      "long-command": desktop,
      read: reading,
      compacting: meditating,
      permission: pointing,
      question: waving,
      plan: lightbulb
    },
    events: {
      start: shot(frames("JumpingHappy", 3, 20)),
      failed: shot(frames("Facepalm", 2, 33), {
        sign: "cross",
        signDuring: [5, 31]
      }),
      "limit-hit": shot([
        ...frames("Dizzy", 6, 21),
        ...frames("Dizzy", 6, 17),
        ...frames("Dizzy", 30, 37),
        standing
      ])
    },
    visits: {
      swaying: shot(frames("Swaying", 4, 48)),
      turning: shot([...frames("Turning", 2, 28), standing]),
      glancing: shot(frames("LookingAroundEyesOnly", 0, 41)),
      dozing: shot(
        [
          ...frames("Meditating", 6, 23),
          ...frames("Meditating", 45, 54),
          standing
        ],
        {
          sign: "z",
          hold: { frame: { name: "Meditating", index: 23 }, seconds: 2 }
        }
      )
    },
    greet: shot([...frames("Waving", 3, 15), ...frames("Waving", 6), standing]),
    gaze: [6, 9, 12, 15, 18, 21, 27, 30],
    cards: {
      done: shot([...frames("Excited", 2, 21), standing]),
      "long-done": shot([
        ...frames("DancingHappy", 4, 38),
        ...frames("DancingHappy", 7),
        standing
      ]),
      reset: shot([...frames("Spark", 4, 21), ...frames("Spark", 57, 68)], {
        offset: { x: -2, y: 0 },
        easeIn: 3,
        easeOut: 4
      })
    },
    pointsAtCard: { name: "Pointing", index: 19 },
    signShifts: { Waving: { x: 7, y: 0 }, Pointing: { x: 5, y: 0 } }
  };

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-signs.ts
  var SIGN_ROWS = {
    exclamation: ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
    question: [".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."],
    lines: [".....", "#####", ".....", "#####", ".....", "#####", "....."],
    cross: [".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "....."],
    hourglass: [".....", "#####", ".#.#.", "..#..", ".###.", "#####", "....."],
    ellipsis: [".....", ".....", ".....", ".....", ".....", ".....", "#.#.#"],
    z: [".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"]
  };
  var signCell = (side) => Math.max(1, Math.min(Math.round(side / 20), Math.round(0.3 * side / 7)));
  function paintSign(context, sign, rect, light, lit = 0, alpha = 1) {
    const matrix = context.getTransform(), corners = [
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y + rect.height]
    ].map(([x, y]) => ({
      x: matrix.a * x + matrix.c * y + matrix.e,
      y: matrix.b * x + matrix.d * y + matrix.f
    })), left = Math.round(Math.min(...corners.map((p) => p.x))), top = Math.round(Math.min(...corners.map((p) => p.y))), cell = Math.max(1, Math.round(Math.abs(corners[1].x - corners[0].x) / 5)), bright = [], dim = [];
    lit = Math.max(0, Math.min(2, lit));
    SIGN_ROWS[sign].forEach(
      (row, y) => [...row].forEach((value, x) => {
        if (value === "#")
          (sign === "ellipsis" && x !== 2 * lit ? dim : bright).push({
            x: left + x * cell,
            y: top + y * cell,
            width: cell,
            height: cell
          });
      })
    );
    const boxes = (list, grow = 0) => {
      const path = new Path2D();
      for (const r of list)
        path.rect(
          r.x - grow,
          r.y - grow,
          r.width + 2 * grow,
          r.height + 2 * grow
        );
      return path;
    };
    context.save();
    context.resetTransform();
    context.globalCompositeOperation = "source-over";
    context.globalAlpha *= alpha;
    if (!light) {
      const ring = boxes(dim, 1);
      ring.addPath(boxes(dim));
      context.fillStyle = "rgba(13,13,15,.21)";
      context.fill(ring, "evenodd");
      context.fillStyle = "rgba(13,13,15,.6)";
      context.fill(boxes(bright, 1));
    }
    context.fillStyle = light ? "#0d0d0f" : "#ffffff";
    context.fill(boxes(bright));
    context.globalAlpha *= 0.35;
    context.fill(boxes(dim));
    context.restore();
  }
  function placed(left, bottom, ceiling, cell, right) {
    const width = 5 * cell, height = 7 * cell;
    bottom = Math.max(Math.round(bottom), Math.ceil(ceiling) + height);
    left = Math.max(1, Math.min(Math.round(left), right - 1 - width));
    return { x: left, y: bottom - height, width, height };
  }
  function signBox(form, side, outline = 0) {
    const inner = Math.ceil(side * 1.6), unit = inner / 1.6, pixels = (value) => outline + (value + 0.3) * unit, foot = form.spec.signAt ?? [form.spec.center[0] + 0.14, form.top - 0.04];
    return placed(
      pixels(foot[0]),
      pixels(foot[1]),
      pixels(-0.28),
      signCell(side),
      inner + outline * 2
    );
  }
  function stillSignImage(sign, form, side, scale, light) {
    scale = Math.max(1, scale);
    const pixels = side * scale, foot = form?.spec.signAt ?? (form ? [form.spec.center[0] + 0.14, form.logoTop - 0.04] : [0.64, 0.06]), box2 = placed(
      foot[0] * pixels,
      foot[1] * pixels,
      -0.28 * pixels,
      signCell(pixels),
      1.3 * pixels
    ), canvas = document.createElement("canvas");
    canvas.width = box2.width + 2;
    canvas.height = box2.height + 2;
    paintSign(
      canvas.getContext("2d"),
      sign,
      { x: 1, y: 1, width: box2.width, height: box2.height },
      light
    );
    return {
      image: canvas,
      frame: {
        x: (box2.x - 1) / scale,
        y: (box2.y - 1) / scale,
        width: canvas.width / scale,
        height: canvas.height / scale
      }
    };
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/scratch.ts
  var spare = [];
  function borrowCanvas(width, height) {
    const canvas = spare.pop() ?? document.createElement("canvas");
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.save();
    return { canvas, context };
  }
  function giveBack(canvas) {
    canvas.getContext("2d").restore();
    if (spare.length < 8) spare.push(canvas);
  }
  function reuseCanvas(canvas, width, height) {
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    } else {
      const context = canvas.getContext("2d");
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.clearRect(0, 0, width, height);
    }
    return canvas;
  }
  function group(context, alpha, draw, operation = "source-over") {
    const { canvas, context: c } = borrowCanvas(
      context.canvas.width,
      context.canvas.height
    );
    c.setTransform(context.getTransform());
    draw(c);
    context.save();
    context.resetTransform();
    context.globalAlpha = alpha;
    context.globalCompositeOperation = operation;
    context.drawImage(canvas, 0, 0);
    context.restore();
    giveBack(canvas);
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-hairline.ts
  var buffers = /* @__PURE__ */ new Map();
  function layHairline(context, reach, light) {
    if (reach <= 0) return;
    reach = Math.floor(reach);
    const width = context.canvas.width, height = context.canvas.height, own = context.getImageData(0, 0, width, height).data;
    const size = `${width}x${height}`;
    let buffer = buffers.get(size);
    if (!buffer) {
      if (buffers.size >= 8) buffers.clear();
      buffer = {
        mask: context.createImageData(width, height),
        rows: new Uint8Array(width * height),
        square: new Uint8Array(width * height)
      };
      buffers.set(size, buffer);
    }
    const { mask, rows, square } = buffer;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let alpha = 0;
        for (let dx = Math.max(-reach, -x); dx <= reach && x + dx < width; dx++)
          alpha = Math.max(alpha, own[(y * width + x + dx) * 4 + 3]);
        rows[y * width + x] = alpha;
      }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let alpha = 0;
        for (let dy = Math.max(-reach, -y); dy <= reach && y + dy < height; dy++)
          alpha = Math.max(alpha, rows[(y + dy) * width + x]);
        square[y * width + x] = alpha;
      }
    const shade = light ? 255 : 0, data = mask.data;
    for (let i = 0; i < width * height; i++) {
      const at = i * 4;
      data[at] = data[at + 1] = data[at + 2] = shade;
      data[at + 3] = Math.round(Math.min(255, square[i] * 3) * 0.5);
    }
    const { canvas } = borrowCanvas(width, height);
    canvas.getContext("2d").putImageData(mask, 0, 0);
    context.save();
    context.resetTransform();
    context.globalAlpha = 1;
    context.globalCompositeOperation = "destination-over";
    context.drawImage(canvas, 0, 0);
    context.restore();
    giveBack(canvas);
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/clawd.ts
  function clawdGrain(side, scale) {
    return Math.max(1, Math.round(1.8 * side * scale / 24));
  }
  function drawsClawdSprites(side, scale) {
    return Math.floor(1.8 * side * scale / 24 + 0.05 + 1e-9) >= 2;
  }
  function fillSprite(context, sprite, index, footX, footY, grain, per, mirrored) {
    const frame = sprite.frames[index];
    for (let y = 0; y < sprite.height; y++)
      for (let x = 0; x < sprite.width; x++) {
        const color = frame[y * sprite.width + x];
        if (color === 255) continue;
        const at = mirrored ? sprite.anchorX - x - 1 : x - sprite.anchorX;
        const left = footX + Math.floor(at * grain / per), right = footX + Math.floor((at + 1) * grain / per);
        const top = footY + Math.floor((y - sprite.anchorY) * grain / per), bottom = footY + Math.floor((y + 1 - sprite.anchorY) * grain / per);
        context.fillStyle = sprite.palette[color];
        context.fillRect(left, top, right - left, bottom - top);
      }
  }
  function drawClawdPixels(context, sheet, picture, side, scale, extent, light) {
    const sprite = sheet[picture.name];
    const grain = clawdGrain(side, scale), flip = picture.mirrored ? -1 : 1;
    const footX = Math.floor(extent / 2) + swiftRound((picture.offsetX ?? 0) * flip * grain / 2);
    const footY = swiftRound(extent / 2 + side * scale * 0.375) + swiftRound((picture.offsetY ?? 0) * grain / 2);
    context.imageSmoothingEnabled = false;
    fillSprite(
      context,
      sprite,
      picture.index,
      footX,
      footY,
      grain,
      2,
      picture.mirrored ?? false
    );
    if (picture.mini !== void 0 && sheet.Walking)
      fillSprite(
        context,
        sheet.Walking,
        0,
        Math.floor(extent / 2) + swiftRound(picture.mini * grain / 2),
        swiftRound(extent / 2 + side * scale * 0.375),
        grain,
        4,
        false
      );
    if (picture.sign) {
      const cell = Math.max(
        1,
        Math.min(
          swiftRound(side * scale / 20),
          swiftRound(0.3 * side * scale / 7)
        )
      );
      const shift = clawdClips.signShifts[picture.name] ?? { x: 0, y: 0 };
      const left = footX + swiftRound(shift.x * grain / 2) + swiftRound(0.14 * side * scale);
      const top = Math.max(
        footY + swiftRound(shift.y * grain / 2) - grain * 8 - swiftRound(0.04 * side * scale) - cell * 7,
        Math.ceil(extent / 2 - side * scale * 0.78)
      );
      drawSign(context, left, top, cell, light, picture.sign);
    }
  }
  var ClawdBaker = class {
    constructor(sheet) {
      this.sheet = sheet;
    }
    kept = /* @__PURE__ */ new Map();
    get count() {
      return this.kept.size;
    }
    purge() {
      this.kept.clear();
    }
    image(picture, side, scale, extent, light, outline = Math.max(
      0,
      Math.floor((extent - Math.ceil(side * scale * 1.6)) / 2)
    )) {
      if (!this.sheet[picture.name]?.frames[picture.index]) return null;
      const key = JSON.stringify([picture, side, scale, extent, light, outline]);
      let canvas = this.kept.get(key);
      if (canvas) this.kept.delete(key);
      else {
        let oldest;
        if (this.kept.size >= 64) {
          const [first, image] = this.kept.entries().next().value;
          this.kept.delete(first);
          oldest = image;
        }
        canvas = reuseCanvas(oldest, extent, extent);
        const context = canvas.getContext("2d");
        if (!context) return null;
        drawClawdPixels(context, this.sheet, picture, side, scale, extent, light);
        if (outline > 0) layHairline(context, outline, light);
      }
      this.kept.set(key, canvas);
      return canvas;
    }
  };
  function drawSign(context, x, y, cell, light, sign) {
    const rows = SIGN_ROWS[sign];
    if (!light) {
      context.fillStyle = "#0d0d0f99";
      rows.forEach(
        (row, j) => [...row].forEach((value, i) => {
          if (value === "#")
            context.fillRect(
              x + i * cell - 1,
              y + j * cell - 1,
              cell + 2,
              cell + 2
            );
        })
      );
    }
    context.fillStyle = light ? "#0d0d0f" : "#ffffff";
    rows.forEach(
      (row, j) => [...row].forEach((value, i) => {
        if (value === "#")
          context.fillRect(x + i * cell, y + j * cell, cell, cell);
      })
    );
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/clawd-sheet.ts
  var canonical = /* @__PURE__ */ new WeakMap();
  var frameKey = (frame) => `${frame.name}:${frame.index}`;
  var rgba = (color) => {
    let value = color.slice(1);
    if (value.length === 3)
      value = [...value].map((digit) => digit + digit).join("");
    if (value.length === 6) value += "ff";
    return value.toLowerCase();
  };
  function canonicalClawdFrame(sheet, frame) {
    let repeats = canonical.get(sheet);
    if (!repeats) {
      repeats = /* @__PURE__ */ new Map();
      const first = /* @__PURE__ */ new Map();
      const names = [
        "Walking",
        ...Object.keys(sheet).filter((name) => name !== "Walking").sort()
      ];
      for (const name of names) {
        const sprite = sheet[name];
        if (!sprite) continue;
        const palette = sprite.palette.map(rgba);
        sprite.frames.forEach((pixels, index) => {
          const signature = [];
          pixels.forEach((ink2, offset) => {
            if (ink2 !== 255)
              signature.push(
                `${offset % sprite.width - sprite.anchorX},${Math.floor(offset / sprite.width) - sprite.anchorY}:${palette[ink2]}`
              );
          });
          const key = signature.join(";"), previous = first.get(key), here = { name, index };
          if (previous) repeats.set(frameKey(here), previous);
          else first.set(key, here);
        });
      }
      canonical.set(sheet, repeats);
    }
    return repeats.get(frameKey(frame)) ?? frame;
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/clawd-script.ts
  var frameStep = (frame, values = {}) => ({ frame, ticks: 1, offset: zeroOffset, ...values });
  function stepsOf(shot2) {
    return shot2.steps.map(
      (step) => frameStep(step.frame, {
        ticks: step.ticks,
        offset: step.offset,
        sign: step.sign
      })
    );
  }
  function introSteps(clip2, frames2) {
    const steps = frames2.map(
      (frame, at) => frameStep(frame, {
        ticks: clip2.ticks,
        offset: easedOffset(
          clip2.offset,
          frames2.length > 1 ? at / (frames2.length - 1) : 1
        ),
        sign: clip2.sign,
        mini: clip2.miniShift
      })
    );
    if (steps.length) steps[steps.length - 1].endsCycle = true;
    return steps;
  }
  function cycle(shown, tick) {
    const clip2 = shown.clip, each = clip2.ticks;
    const make = (index, ticks) => frameStep(
      { name: clip2.sprite, index },
      { ticks, offset: clip2.offset, sign: clip2.sign, mini: clip2.miniShift }
    );
    if (shown.still || !clip2.loop.length)
      return [
        {
          ...clip2.loop.length ? make(clip2.loop[0], Infinity) : frameStep(null, { ticks: Infinity }),
          holds: true
        }
      ];
    let steps = clip2.loop.map((index) => make(index, each));
    const looped = tick - (shown.epoch ?? tick), past = (seconds) => looped >= clawdTicks(seconds), pace = clip2.pace;
    if (pace.kind === "resting" && past(pace.after)) {
      steps[0].ticks += clawdTicks(pace.hold);
      steps[0].holds = true;
    } else if (pace.kind === "waiting" && past(pace.after)) {
      steps[0].ticks = Math.max(
        each,
        clawdTicks(past(pace.slowAfter) ? pace.slowEvery : pace.every) - (steps.length - 1) * each
      );
      steps[0].holds = true;
    } else if (pace.kind === "replaying" && past(pace.after)) {
      steps = [
        {
          ...make(
            pace.hold,
            Math.max(each, clawdTicks(pace.every) - pace.replay.length * each)
          ),
          holds: true
        },
        ...pace.replay.map((index) => make(index, each))
      ];
    }
    steps[steps.length - 1].endsCycle = true;
    return steps;
  }
  function outroSteps(clip2) {
    return clip2.outro.map(
      (frame, at) => frameStep(frame, {
        ticks: clip2.ticks,
        offset: easedOffset(
          clip2.offset,
          clip2.outro.length > 1 ? 1 - at / (clip2.outro.length - 1) : 0
        ),
        mini: clip2.miniShift,
        outro: true
      })
    );
  }
  function exitLead(clip2) {
    if (clip2.exit.kind !== "through") return [];
    const at = clip2.loop.indexOf(clip2.exit.frame);
    if (at < 0) return [];
    return clip2.loop.slice(0, at + 1).map(
      (index) => frameStep(
        { name: clip2.sprite, index },
        { ticks: clip2.ticks, offset: clip2.offset, mini: clip2.miniShift }
      )
    );
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/clawd-player.ts
  var tickAt = (time) => Math.floor((time + 4e-3) * 12);
  var samePicture = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  var ClawdPlayer = class _ClawdPlayer {
    clips = clawdClips;
    restMode;
    canonical = (frame) => frame;
    target = null;
    subagents = false;
    pendingEvent = null;
    badge;
    hovered = false;
    sector = null;
    activity = { kind: "resting" };
    script;
    start = 0;
    tick = 0;
    cameInAt = null;
    showing;
    appearanceSince = 0;
    constructor(rest) {
      this.restMode = rest;
      this.script = [this.restStep()];
      this.showing = this.restMode === "standing";
    }
    get picture() {
      return this.pictureOf(this.script[0]);
    }
    get appearanceChangedAt() {
      return this.appearanceSince;
    }
    setCanonical(canonical2) {
      this.canonical = canonical2;
    }
    get due() {
      return this.nextChange() ?? Infinity;
    }
    get shown() {
      return "shown" in this.activity ? this.activity.shown.look : null;
    }
    get playing() {
      return this.activity.kind === "event" ? this.activity.event : null;
    }
    get switchPoint() {
      return this.switchTick / 12;
    }
    get atSwitchPoint() {
      return this.switchTick <= this.tick + 1;
    }
    get switchTick() {
      const activity = this.activity;
      switch (activity.kind) {
        case "resting":
        case "visit":
        case "greeting":
        case "gazing":
        case "card":
        case "at-card":
          return this.tick;
        case "looping": {
          if (this.script[0].holds || activity.shown.clip.exit.kind === "any-frame" || sameFrame(this.picture, this.canonical(standing)))
            return this.tick + 1;
          let end = this.start;
          for (const step of this.script) {
            end += step.ticks;
            if (step.endsCycle) break;
          }
          return end;
        }
        default:
          return this.script.reduce(
            (time, step) => Number.isFinite(step.ticks) ? time + step.ticks : time,
            this.start
          );
      }
    }
    show(look, time, subagents = false) {
      const now = this.stepTo(time);
      this.subagents = subagents;
      const activity = this.activity, atCard = activity.kind === "at-card";
      if (look === this.target && !atCard) return;
      this.target = look;
      switch (activity.kind) {
        case "resting":
        case "visit":
        case "greeting":
        case "gazing":
        case "card":
        case "at-card":
          if (look === null) {
            if (atCard) this.rest(now);
          } else {
            this.cameInAt = now;
            this.enter(look, null, now);
          }
          break;
        case "entering":
        case "looping": {
          const shown = activity.shown;
          if (look && isClawdAttention(look) && look !== shown.look)
            this.enter(look, null, now);
          else if (look && this.sameClip(look, shown)) {
            if (activity.kind === "looping" && shown.still !== (look === "retrying"))
              this.endHold(now);
          } else if (activity.kind === "looping") this.leave(shown, now);
          break;
        }
        case "leaving":
          if (look && isClawdAttention(look)) this.enter(look, null, now);
          else if (look && this.sameClip(look, activity.shown) && !this.script[0].outro) {
            this.activity = { kind: "looping", shown: activity.shown };
            this.script = this.script.filter((step) => !step.outro).map((step) => ({ ...step, sign: activity.shown.clip.sign }));
          }
          break;
        case "event":
          if (look && isClawdAttention(look)) this.enter(look, null, now);
          break;
      }
    }
    resume(look, time, subagents = false) {
      const now = this.stepTo(time);
      this.target = look;
      this.subagents = subagents;
      this.loop(
        {
          look,
          clip: this.clips.looks[look],
          still: look === "retrying",
          epoch: now
        },
        now
      );
    }
    play(event, time) {
      const now = this.stepTo(time), activity = this.activity;
      switch (activity.kind) {
        case "resting":
        case "visit":
        case "greeting":
        case "gazing":
        case "card":
        case "at-card":
          this.playShot(event, null, now);
          break;
        case "entering":
          if (this.cameInAt === now && !isClawdAttention(activity.shown.look))
            this.playShot(event, null, now);
          else this.pendingEvent = event;
          break;
        case "looping":
          this.pendingEvent = event;
          if (!isClawdAttention(activity.shown.look)) this.endHold(now);
          break;
        default:
          this.pendingEvent = event;
      }
    }
    cancelEvent() {
      this.pendingEvent = null;
    }
    visit(visit, time) {
      const now = this.stepTo(time);
      if (this.activity.kind !== "resting" || this.target !== null || this.pendingEvent !== null)
        return;
      this.activity = { kind: "visit" };
      this.begin(stepsOf(this.clips.visits[visit]), now);
    }
    greet(time) {
      const now = this.stepTo(time);
      this.hovered = true;
      if ((this.activity.kind === "resting" || this.activity.kind === "visit") && this.target === null) {
        this.activity = { kind: "greeting" };
        this.begin(stepsOf(this.clips.greet), now);
      }
    }
    endHover(time) {
      const now = this.stepTo(time);
      this.hovered = false;
      if (this.activity.kind === "gazing") this.rest(now);
    }
    look(aim, time) {
      const now = this.stepTo(time), sector = _ClawdPlayer.sectorOf(aim);
      if (sector === null || sector === this.sector) return;
      this.sector = sector;
      if (this.activity.kind === "gazing") this.gaze(now);
    }
    card(card, time) {
      const now = this.stepTo(time);
      this.target = null;
      this.pendingEvent = null;
      this.activity = { kind: "card" };
      this.begin(stepsOf(this.clips.cards[card]), now);
    }
    pointAtCard(mirrored, time) {
      this.holdAtCard(
        frameStep(this.clips.pointsAtCard, {
          ticks: Infinity,
          holds: true,
          mirrored
        }),
        time
      );
    }
    standAtCard(look, time) {
      const clip2 = this.clips.looks[look], first = clip2.loop[0];
      const held = clip2.sign === void 0 && first !== void 0 ? frameStep(
        { name: clip2.sprite, index: first },
        { ticks: Infinity, offset: clip2.offset, holds: true }
      ) : frameStep(standing, {
        ticks: Infinity,
        sign: clip2.sign,
        holds: true
      });
      this.holdAtCard(held, time);
    }
    setBadge(badge, time) {
      this.stepTo(time);
      this.badge = badge;
    }
    advance(time) {
      this.stepTo(time);
      return this.picture;
    }
    restStep() {
      return frameStep(this.restMode === "standing" ? standing : null, {
        ticks: Infinity,
        holds: true
      });
    }
    stepTo(time) {
      const tick = Math.max(this.tick, tickAt(time));
      this.playTo(tick);
      this.tick = tick;
      return tick;
    }
    playTo(tick) {
      while (Number.isFinite(this.script[0].ticks) && this.start + this.script[0].ticks <= tick) {
        this.start += this.script[0].ticks;
        this.script.shift();
        if (!this.script.length) this.proceed(this.start);
      }
    }
    nextChange() {
      const picture = this.picture;
      const probe = this.clone();
      for (let at = 0; at < 1e4; at++) {
        if (!Number.isFinite(probe.script[0].ticks)) return null;
        const end = probe.start + probe.script[0].ticks;
        probe.playTo(end);
        if (!samePicture(probe.picture, picture)) return end / 12;
      }
      return null;
    }
    clone() {
      const probe = new _ClawdPlayer(this.restMode);
      probe.canonical = this.canonical;
      probe.target = this.target;
      probe.subagents = this.subagents;
      probe.pendingEvent = this.pendingEvent;
      probe.badge = this.badge;
      probe.hovered = this.hovered;
      probe.sector = this.sector;
      probe.activity = this.activity;
      probe.script = this.script.map((step) => ({ ...step }));
      probe.start = this.start;
      probe.tick = this.tick;
      probe.cameInAt = this.cameInAt;
      probe.showing = this.showing;
      probe.appearanceSince = this.appearanceSince;
      return probe;
    }
    pictureOf(step) {
      if (!step.frame) return null;
      const frame = this.canonical(step.frame), sign = shownSign(step.sign ?? null, this.badge ?? null);
      return {
        name: frame.name,
        index: frame.index,
        offsetX: step.offset.x,
        offsetY: step.offset.y,
        ...sign ? { sign } : {},
        ...this.subagents && step.mini !== void 0 ? { mini: step.mini } : {},
        mirrored: step.mirrored ?? false
      };
    }
    sameClip(look, shown) {
      return this.clips.looks[look].name === shown.clip.name;
    }
    begin(steps, tick) {
      this.start = tick;
      this.script = steps;
      if (!steps.length) {
        this.proceed(tick);
        return;
      }
      const showing = steps[0].frame !== null;
      if (showing !== this.showing) {
        this.showing = showing;
        this.appearanceSince = tick / 12;
      }
    }
    proceed(tick) {
      const activity = this.activity;
      switch (activity.kind) {
        case "entering":
        case "looping":
          this.reachSwitch(activity.shown, tick);
          break;
        case "leaving":
          if (this.pendingEvent && !(this.target && isClawdAttention(this.target)))
            this.playShot(this.pendingEvent, null, tick);
          else if (this.target) this.enter(this.target, activity.shown, tick);
          else this.rest(tick);
          break;
        case "event":
          if (this.pendingEvent && !(this.target && isClawdAttention(this.target)))
            this.playShot(this.pendingEvent, activity.resume, tick);
          else if (this.target && activity.resume && this.sameClip(this.target, activity.resume))
            this.loop(
              {
                look: this.target,
                clip: activity.resume.clip,
                still: this.target === "retrying",
                epoch: activity.resume.epoch
              },
              tick
            );
          else if (this.target) this.enter(this.target, null, tick);
          else this.rest(tick);
          break;
        case "greeting":
          if (this.hovered) this.gaze(tick);
          else this.rest(tick);
          break;
        case "visit":
        case "card":
          if (this.target) this.enter(this.target, null, tick);
          else this.rest(tick);
          break;
        default:
          this.rest(tick);
      }
    }
    reachSwitch(shown, tick) {
      if (this.pendingEvent && !isClawdAttention(shown.look)) {
        this.playShot(this.pendingEvent, shown, tick);
        return;
      }
      if (!this.target || !this.sameClip(this.target, shown)) {
        this.leave(shown, tick);
        return;
      }
      this.loop(
        { ...shown, look: this.target, still: this.target === "retrying" },
        tick
      );
    }
    rest(tick) {
      this.activity = { kind: "resting" };
      this.begin([this.restStep()], tick);
    }
    holdAtCard(step, time) {
      const now = this.stepTo(time);
      this.activity = { kind: "at-card" };
      this.begin([step], now);
    }
    gaze(tick) {
      this.activity = { kind: "gazing" };
      const frame = this.sector === null ? standing : {
        name: "LookingAroundEyesOnly",
        index: this.clips.gaze[this.sector % this.clips.gaze.length]
      };
      this.begin([frameStep(frame, { ticks: Infinity, holds: true })], tick);
    }
    playShot(event, resume, tick) {
      this.pendingEvent = null;
      this.activity = { kind: "event", event, resume };
      this.begin(stepsOf(this.clips.events[event]), tick);
    }
    enter(look, source, tick) {
      const clip2 = this.clips.looks[look], handover = source !== null && source.clip.working && clip2.working;
      const frames2 = handover ? clip2.entry ?? clip2.intro : clip2.intro;
      this.activity = {
        kind: "entering",
        shown: { look, clip: clip2, still: look === "retrying", epoch: null }
      };
      this.begin(introSteps(clip2, frames2), tick);
    }
    loop(shown, tick) {
      const next = { ...shown, epoch: shown.epoch ?? tick };
      this.activity = { kind: "looping", shown: next };
      this.begin(cycle(next, tick), tick);
    }
    leave(shown, tick) {
      const clip2 = shown.clip, empty = !this.script.length;
      let lead;
      if (empty) lead = exitLead(clip2);
      else {
        lead = this.script.map((step) => ({ ...step }));
        if (lead[0].holds) lead[0].ticks = tick + 1 - this.start;
        switch (clip2.exit.kind) {
          case "cycle-end":
            if (this.script[0].holds) lead = [lead[0]];
            break;
          case "any-frame":
            lead = [lead[0]];
            break;
          case "through": {
            const at = lead.findIndex(
              (step) => sameFrame(step.frame, {
                name: clip2.sprite,
                index: clip2.exit.kind === "through" ? clip2.exit.frame : 0
              })
            );
            lead = at >= 0 ? lead.slice(0, at + 1) : [...lead, ...exitLead(clip2)];
            break;
          }
        }
        lead = lead.map(
          (step, at) => at > 0 && step.holds ? { ...step, ticks: clip2.ticks } : step
        );
      }
      lead = lead.map((step, at) => ({
        ...step,
        sign: at > 0 || empty ? void 0 : step.sign,
        holds: false,
        endsCycle: false
      }));
      const outro = outroSteps(clip2);
      this.activity = { kind: "leaving", shown };
      if (empty) this.begin([...lead, ...outro], tick);
      else this.script = [...lead, ...outro];
    }
    endHold(tick) {
      if (this.activity.kind !== "looping" || !this.script[0].holds) return;
      this.script = [
        { ...this.script[0], ticks: tick + 1 - this.start, endsCycle: true }
      ];
    }
    static sectorOf(aim) {
      if (Math.hypot(...aim) < 0.02) return null;
      const turns = Math.sign(Math.atan2(-aim[1], aim[0])) * Math.floor(Math.abs(Math.atan2(-aim[1], aim[0]) / (Math.PI / 4)) + 0.5);
      return (turns % 8 + 8) % 8;
    }
  };

  // ../ext-hud/repo/src/packages/hud/src/bots/clawd-performer.ts
  var following = (time) => (Math.floor((time + 4e-3) * 12) + 1) / 12;
  var ClawdPerformer = class _ClawdPerformer {
    player;
    staysBot;
    arrivesAfter;
    state = botState();
    due = Infinity;
    told = false;
    arrival = null;
    onStage;
    nextVisit = null;
    visiting = false;
    greetAt = null;
    watching = false;
    asked = null;
    lastCue = null;
    random = new SplitMix();
    constructor(options = {}) {
      this.staysBot = options.staysBot ?? false;
      this.arrivesAfter = this.staysBot ? Math.max(0, options.arrivesAfter ?? 0) : 0;
      this.onStage = !this.staysBot;
      this.player = new ClawdPlayer(this.staysBot ? "standing" : "logo");
    }
    get picture() {
      return this.onStage ? this.player.picture : null;
    }
    get logoSign() {
      return this.state.badge === "failed" ? "cross" : this.state.badge === "limited" ? "hourglass" : void 0;
    }
    get appearanceChangedAt() {
      return this.player.appearanceChangedAt;
    }
    get playing() {
      return this.player.playing;
    }
    get switchPoint() {
      return this.player.switchPoint;
    }
    get atSwitchPoint() {
      return this.player.atSwitchPoint;
    }
    set(next, now) {
      const before = this.told ? this.state : null;
      this.state = { ...next };
      this.told = true;
      if (this.staysBot && this.arrival === null)
        this.arrival = frameAfter(now + this.arrivesAfter);
      if (this.onStage) this.apply(before, now);
      this.findDue(now);
    }
    resume(next, now) {
      this.set(next, now);
      const look = _ClawdPerformer.lookFor(next);
      if (this.onStage && (next.facing === null || !isAttention(next.look)) && look !== null)
        this.player.resume(look, now, next.subagents);
      this.findDue(now);
    }
    play(event, now) {
      this.letGoOfStaleEvent(now);
      if (this.asked && (this.player.pendingEvent !== null || !this.onStage) && eventRank(this.asked.event) > eventRank(event))
        return;
      this.asked = { event, at: now };
      if (this.onStage) this.player.play(event, now);
      this.findDue(now);
    }
    /** A cue survives React snapshots without replaying, and is discarded if its original timestamp is stale. */
    playCue(cue, now) {
      if (!cue || now - cue.at > BOT_EVENT_FRESHNESS) return;
      if (this.lastCue && (cue.at < this.lastCue.at || cue.at === this.lastCue.at && eventRank(cue.event) <= eventRank(this.lastCue.event)))
        return;
      this.lastCue = { ...cue };
      this.play(cue.event, now);
      if (this.asked?.event === cue.event) this.asked.at = cue.at;
    }
    step(now, aim = [0, 0]) {
      if (!this.onStage && this.arrival !== null && now >= this.arrival - 4e-3) {
        this.onStage = true;
        if (this.asked && this.arrival - this.asked.at <= BOT_EVENT_FRESHNESS)
          this.player.play(this.asked.event, this.arrival);
        this.apply(null, this.arrival);
      }
      this.letGoOfStaleEvent(now);
      if (this.greetAt !== null && now >= this.greetAt - 4e-3) {
        this.greetAt = null;
        if (isCalm(this.state.look)) {
          this.player.greet(now);
          this.watching = true;
        }
      }
      if (this.watching) this.player.look(aim, now);
      if (this.visits && this.nextVisit !== null && now >= this.nextVisit - 4e-3) {
        const idle = ["swaying", "turning", "glancing"];
        this.player.visit(
          this.state.look === "asleep" ? "dozing" : idle[Math.floor(this.random.unit() * idle.length)],
          now
        );
        this.visiting = this.player.picture !== null;
        this.nextVisit = null;
        if (!this.visiting) this.scheduleVisit(now);
      }
      this.player.advance(now);
      if (this.visiting && this.player.picture === null) {
        this.visiting = false;
        this.scheduleVisit(now);
      }
      this.findDue(now);
      return this.picture;
    }
    apply(before, now) {
      this.letGoOfStaleEvent(now);
      const state = this.state, look = _ClawdPerformer.lookFor(state);
      if (state.look === "done") {
        if (before?.look !== "done" || before.card !== state.card)
          this.player.card(state.card, now);
      } else if (isAttention(state.look) && state.facing !== null && look !== null) {
        if (before?.facing !== state.facing || before.look !== state.look) {
          if (state.facing === "left" || state.facing === "right")
            this.player.pointAtCard(state.facing === "left", now);
          else this.player.standAtCard(look, now);
        }
      } else this.player.show(look, now, state.subagents);
      this.player.setBadge(this.logoSign, now);
      if (state.hovered !== (before?.hovered ?? false)) {
        if (state.hovered) this.greetAt = frameAfter(now + 0.3);
        else {
          this.greetAt = null;
          this.watching = false;
          this.player.endHover(now);
        }
      }
      if (!isCalm(state.look)) this.watching = false;
      if (state.look !== before?.look || state.hovered !== before?.hovered) {
        this.visiting = false;
        this.nextVisit = null;
        if (this.visits) this.scheduleVisit(now);
      }
    }
    get visits() {
      return !this.staysBot && !this.state.hovered && (this.state.look === "idle" || this.state.look === "asleep");
    }
    scheduleVisit(now) {
      this.nextVisit = frameAfter(
        now + (this.state.look === "asleep" ? 180 + this.random.unit() * 120 : 20 + this.random.unit() * 15)
      );
    }
    letGoOfStaleEvent(now) {
      if (!this.asked || now - this.asked.at <= BOT_EVENT_FRESHNESS) return;
      if (this.onStage && this.player.pendingEvent !== null)
        this.player.cancelEvent();
      this.asked = null;
    }
    findDue(now) {
      this.due = Math.min(
        this.onStage ? this.player.due : this.arrival ?? Infinity,
        this.greetAt ?? Infinity,
        this.visits ? this.nextVisit ?? Infinity : Infinity,
        this.watching ? following(now) : Infinity
      );
    }
    static lookFor(state) {
      switch (state.look) {
        case "permission":
        case "question":
        case "plan":
        case "compacting":
          return state.look;
        case "thinking":
          return state.holds ? "retrying" : "thinking";
        case "tool-edit":
          return "edit";
        case "tool-command":
        case "plain":
          return "command";
        case "tool-read":
          return "read";
        case "tool-long-command":
          return "long-command";
        default:
          return null;
      }
    }
  };

  // ../ext-hud/repo/src/packages/hud/src/bots/clawd-actor.ts
  var logo = { picture: null };
  function fadeCurve(progress) {
    const x = Math.max(0, Math.min(1, progress));
    if (x === 0 || x === 1) return x;
    let low = 0, high = 1;
    for (let i = 0; i < 16; i++) {
      const t2 = (low + high) / 2;
      const bx = 3 * (1 - t2) ** 2 * t2 * 0.2 + 3 * (1 - t2) * t2 * t2 * 0.2 + t2 ** 3;
      if (bx < x) low = t2;
      else high = t2;
    }
    const t = (low + high) / 2;
    return 3 * (1 - t) ** 2 * t * 0.8 + 3 * (1 - t) * t * t + t ** 3;
  }
  var ClawdActor = class _ClawdActor {
    static fade = 0.3;
    static keepsFrames = 60;
    performer;
    baker = null;
    restsHidden;
    seen;
    back = null;
    fadeAt = -Infinity;
    fadesUntil = -Infinity;
    opacityFrom = 1;
    opacityTarget = 1;
    opacityAt = -Infinity;
    restingSince = null;
    resumes;
    constructor(options = {}) {
      this.performer = new ClawdPerformer(options);
      this.restsHidden = options.restsHidden ?? true;
      this.resumes = options.resumes ?? false;
      this.seen = this.resumes ? null : logo;
    }
    get state() {
      return this.performer.state;
    }
    get playing() {
      return this.performer.playing;
    }
    get picture() {
      return this.performer.picture;
    }
    get switchPoint() {
      return this.performer.switchPoint;
    }
    get atSwitchPoint() {
      return this.performer.atSwitchPoint;
    }
    set(state, now) {
      this.performer.set(state, now);
      this.sync(now);
    }
    resume(state, now) {
      this.performer.resume(state, now);
      this.sync(now);
    }
    play(event, now) {
      this.performer.play(event, now);
      this.sync(now);
    }
    playCue(cue, now) {
      this.performer.playCue(cue, now);
      this.sync(now);
    }
    useSheet(sheet) {
      if (this.baker?.sheet === sheet) return;
      this.baker = new ClawdBaker(sheet);
      this.performer.player.setCanonical(
        (frame) => canonicalClawdFrame(sheet, frame)
      );
    }
    redraw() {
      this.baker?.purge();
    }
    step(now, aim = [0, 0]) {
      this.performer.step(now, aim);
      this.sync(now);
      const front = this.seen ?? logo;
      const share = this.back ? fadeCurve((now - this.fadeAt) / _ClawdActor.fade) : 1;
      const opacity = this.opacityAt === -Infinity ? this.opacityTarget : this.opacityFrom + (this.opacityTarget - this.opacityFrom) * fadeCurve((now - this.opacityAt) / _ClawdActor.fade);
      const visible = !(this.restsHidden && front.picture === null && front.sign === void 0 && this.back === null && opacity === 1);
      let due = this.performer.due;
      if (this.fadesUntil > now)
        due = Math.min(
          due,
          this.fadesUntil,
          (Math.floor((now + 4e-3) * 24) + 1) / 24
        );
      if (front.picture === null && this.restingSince !== null && this.baker && this.baker.count > 0)
        due = Math.min(
          due,
          frameAfter(this.restingSince + _ClawdActor.keepsFrames)
        );
      this.resumes = false;
      return {
        front,
        back: this.back,
        frontOpacity: share,
        backOpacity: 1 - share,
        opacity,
        visible,
        due
      };
    }
    sync(now) {
      if (now >= this.fadesUntil - 4e-3) this.back = null;
      const picture = this.performer.picture;
      const next = {
        picture,
        ...picture === null && this.performer.logoSign ? { sign: this.performer.logoSign } : {}
      };
      if (picture === null) this.restingSince ??= now;
      else if (!["no-news", "idle", "asleep"].includes(this.state.look))
        this.restingSince = null;
      if (picture === null && this.restingSince !== null && now - this.restingSince >= _ClawdActor.keepsFrames - 4e-3)
        this.baker?.purge();
      if (this.seen && this.seen.picture === null !== (picture === null)) {
        this.back = this.seen;
        const changedAt = picture === null ? this.performer.appearanceChangedAt : now;
        this.fadeAt = changedAt;
        this.fadesUntil = Math.max(
          this.fadesUntil,
          frameAfter(changedAt + _ClawdActor.fade)
        );
        if (now >= this.fadesUntil - 4e-3) this.back = null;
      }
      this.seen = next;
      const opacity = picture === null && this.state.look === "no-news" ? 0.5 : 1;
      if (opacity !== this.opacityTarget) {
        this.opacityFrom = this.opacityAt === -Infinity ? this.opacityTarget : this.opacityFrom + (this.opacityTarget - this.opacityFrom) * fadeCurve((now - this.opacityAt) / _ClawdActor.fade);
        this.opacityTarget = opacity;
        if (this.resumes) {
          this.opacityFrom = opacity;
          this.opacityAt = -Infinity;
        } else {
          this.opacityAt = now;
          this.fadesUntil = Math.max(
            this.fadesUntil,
            frameAfter(now + _ClawdActor.fade)
          );
        }
      }
    }
  };

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-actor.ts
  var BotActor = class {
    motion;
    clawd;
    state;
    cue = null;
    fitted = null;
    renderer = null;
    next = 0;
    frame = null;
    get due() {
      return this.next;
    }
    invalidate() {
      this.next = 0;
    }
    selectRenderer(renderer) {
      if (renderer !== this.renderer) {
        this.renderer = renderer;
        this.invalidate();
      }
    }
    constructor(state, now, options = {}) {
      this.state = state;
      this.motion = new BotMotion();
      this.motion.staysBot = options.staysBot ?? false;
      this.motion.arrivesAfter = options.arrivesAfter ?? 0;
      this.clawd = new ClawdActor({
        ...options,
        resumes: options.awake,
        restsHidden: false
      });
      this.motion.set(state, now);
      if (options.awake) {
        this.motion.resume(now);
        this.clawd.resume(state, now);
      } else this.clawd.set(state, now);
    }
    fit(form) {
      if (this.fitted !== form) {
        this.fitted = form;
        this.motion.fit(form.spec);
        this.invalidate();
      }
    }
    set(state, now) {
      if (sameBotState(this.state, state)) return false;
      this.state = state;
      this.motion.set(state, now);
      this.clawd.set(state, now);
      this.invalidate();
      return true;
    }
    playCue(cue, now) {
      if (!cue || this.cue?.event === cue.event && this.cue.at === cue.at)
        return false;
      this.cue = cue;
      if (now - cue.at <= 3) {
        this.motion.play(cue.event, cue.at);
        this.clawd.playCue(cue, now);
        this.invalidate();
        return true;
      }
      return false;
    }
    step(now, aim, renderer = "procedural") {
      this.selectRenderer(renderer);
      if (now < this.next - 4e-3) {
        return { stepped: false, renderer, due: this.next, frame: this.frame };
      }
      if (renderer === "clawd") {
        this.frame = this.clawd.step(now, aim);
        this.next = this.frame.due;
      } else {
        this.motion.step(now, aim);
        this.next = this.motion.wait === null ? Infinity : now + this.motion.wait;
      }
      return { stepped: true, renderer, due: this.next, frame: this.frame };
    }
  };

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-spec.ts
  var basic = {
    radius: 0.36,
    center: [0.5, 0.5],
    reach: 1,
    shape: { kind: "circle" },
    face: [0, 0],
    eye: { height: 0.62, width: 0.25, round: 1, spread: 0.34 }
  };
  var spec = (value) => ({ ...basic, ...value, eye: { ...basic.eye, ...value.eye } });
  var mono = (light, dark = "#ffffff") => light ? "#1d1d1f" : dark;
  function botSpecs(light) {
    const cat = (head, face) => spec({
      center: [0.5, 0.55],
      reach: 0.5,
      shape: { kind: "cat" },
      paint: head,
      face: [0, 0.2],
      eye: { height: 0.84, width: 0.36 },
      eyeColor: "#ffffff",
      patch: { box: [-0.9, -0.52, 0.9, 1.3], round: 0.5, paint: face },
      crossesEyes: true
    });
    return {
      claude: spec({
        radius: 0.22,
        center: [0.5, 0.445],
        reach: 0.7,
        shape: { kind: "rect", width: 0.66, height: 0.44, round: 8e-3 },
        face: [0, -0.25],
        eye: { height: 0.64, width: 0.32, round: 0, across: 0.875 },
        limbs: {
          arms: [
            [-2, 0, -1.5, 0.5],
            [1.5, 0, 2, 0.5]
          ],
          legs: [
            [-1.25, 1, -1, 1.5],
            [-0.75, 1, -0.5, 1.5],
            [0.5, 1, 0.75, 1.5],
            [1, 1, 1.25, 1.5]
          ],
          pixel: 0.5
        }
      }),
      openai: spec({
        radius: 0.37,
        shape: { kind: "outline", keep: 1.1, smooth: 5 },
        spin: 7,
        crossesEyes: true
      }),
      antigravity: spec({
        reach: 0.75,
        shape: { kind: "outline", keep: 0.5, smooth: 16 },
        face: [0, -0.2],
        settle: 0.093
      }),
      deepseek: spec({
        face: [0, -0.14],
        crossesEyes: true,
        decor: [
          {
            kind: "fins",
            color: "#3f5ae6",
            fins: [
              {
                root: [-0.5, 0.38],
                angle: 142,
                length: 0.7,
                base: 0.27,
                tip: 0.06,
                sweep: 0,
                hand: -1
              },
              {
                root: [0.5, 0.38],
                angle: 38,
                length: 0.7,
                base: 0.27,
                tip: 0.06,
                sweep: 0,
                hand: 1
              },
              {
                root: [-0.12, -0.7],
                angle: -100,
                length: 0.64,
                base: 0.34,
                tip: 0.15,
                sweep: 0.22,
                hand: 0
              }
            ]
          },
          {
            kind: "soft",
            boxes: [[-0.86, 0.34, 0.86, 1.9]],
            color: "#c9d4ff",
            round: 1
          }
        ]
      }),
      grok: spec({
        radius: 0.33,
        reach: 0.55,
        face: [0, -0.3],
        ring: { radiusX: 1.5, radiusY: 0.32, drop: 0.3, tilt: -20, width: 0.14 }
      }),
      "grok-bot": spec({
        radius: 0.37,
        paint: light ? "#000000" : "#ffffff",
        crossesEyes: true,
        eye: { height: 0.78, width: 0.3 },
        eyeColor: light ? "#f5f5f7" : void 0
      }),
      cursor: spec({
        radius: 0.41,
        reach: 0.7,
        shape: { kind: "polygon", sides: 6, rotation: -90, round: 0.07 },
        face: [-0.12, 0.16],
        decor: [
          {
            kind: "notch",
            points: [
              [0.32, -0.954],
              [0.75, -0.704],
              [0.266, -0.361]
            ]
          }
        ],
        eyeColor: light ? "#f5f5f7" : void 0
      }),
      opencode: spec({
        reach: 0.5,
        shape: { kind: "rect", width: 0.66, height: 0.66, round: 0.04 },
        paint: light ? "#211e1e" : "#f1ecec",
        face: [0, -0.02],
        eye: { height: 0.4, width: 0.24, round: 0.12 },
        eyeColor: light ? "#f5f5f7" : void 0,
        decor: [
          {
            kind: "blocks",
            boxes: [
              [-1, -1.06, 1, -0.56],
              [-1, -0.56, -0.62, -0.36],
              [-0.24, -0.56, 0.16, -0.42],
              [0.58, -0.56, 1, -0.3]
            ],
            color: light ? "#cfcecd" : "#4b4646"
          },
          {
            kind: "blocks",
            boxes: [[-0.6, 0.36, 0.6, 0.6]],
            color: light ? "#cfcecd" : "#4b4646",
            follows: true
          }
        ]
      }),
      kimi: spec({
        radius: 0.32,
        center: [0.41, 0.59],
        shape: { kind: "outline", keep: 0.3, smooth: 22 },
        keeps: [0.78, 0.02, 0.995, 0.235],
        signAt: [0.44, 0.22],
        eyeColor: light ? "#f5f5f7" : void 0
      }),
      glm: spec({
        shape: { kind: "rect", width: 0.74, height: 0.74, round: 0.16 },
        paint: "#28282b",
        eyeColor: "#ffffff",
        stroke: "#ffffff"
      }),
      pi: spec({
        center: [0.5, 0.31],
        reach: 0.3,
        shape: { kind: "rect", width: 0.9, height: 0.29, round: 0.02 },
        eye: { height: 0.3, width: 0.3, round: 0 },
        eyeColor: light ? "#f5f5f7" : void 0,
        decor: [
          {
            kind: "blocks",
            boxes: [
              [-0.8, 0.36, -0.3, 1.5],
              [0.3, 0.36, 0.8, 1.5]
            ],
            color: mono(light)
          }
        ]
      }),
      hermes: spec({
        crossesEyes: true,
        radius: 0.35,
        reach: 0.5,
        paint: mono(light, "#f8f8f9"),
        face: [0, 0.24],
        eye: { height: 0.72, width: 0.3, spread: 0.44 },
        eyeColor: light ? "#f5f5f7" : void 0,
        decor: [
          {
            kind: "soft",
            boxes: [
              [-1.1, -1.25, -0.2, -0.22],
              [-0.44, -1.3, 0.44, -0.3],
              [0.2, -1.25, 1.1, -0.22]
            ],
            color: "#b7b6c2",
            round: 1
          }
        ]
      }),
      zcode: spec({
        reach: 0.8,
        shape: {
          kind: "rect",
          width: 0.66,
          height: 0.64,
          skew: 0.2,
          round: 0.05
        },
        eyeColor: light ? "#f5f5f7" : void 0
      }),
      qwen: spec({
        radius: 0.37,
        shape: { kind: "outline", keep: 0.55, smooth: 7 },
        spin: 7,
        crossesEyes: true
      }),
      devin: spec({
        reach: 0.55,
        shape: { kind: "outline", keep: 1, smooth: 5 },
        paint: mono(light),
        eye: { across: 0.42 },
        eyeColor: light ? "#f5f5f7" : void 0
      }),
      openclaw: spec({
        crossesEyes: true,
        center: [0.5, 0.54],
        reach: 0.7,
        paint: {
          from: [0.2, 0.1],
          to: [0.85, 0.95],
          colors: ["#ee4747", "#c22e2e"]
        },
        face: [0, 0.06],
        eye: { height: 0.46, width: 0.46, spread: 0.46 },
        eyeColor: "#050810",
        decor: [
          {
            kind: "feelers",
            lines: [
              [
                [-0.24, -0.9],
                [-0.34, -1.14],
                [-0.54, -1.22]
              ],
              [
                [0.24, -0.9],
                [0.34, -1.14],
                [0.54, -1.22]
              ]
            ],
            color: "#ea4a4a",
            width: 0.1
          }
        ]
      }),
      codebuddy: cat(mono(light), {
        from: [0.2, 0.2],
        to: [0.85, 1],
        colors: ["#5570da", "#4587c1", "#369dab"]
      }),
      workbuddy: cat(light ? "#1b2622" : "#eafaf6", {
        from: [0.5, 0.55],
        to: [0.5, 1],
        colors: ["#00cd8c", "#7dd76d"]
      }),
      qoder: spec({
        crossesEyes: true,
        reach: 0.55,
        paint: light ? "#161616" : "#f8f8f8",
        face: [0, -0.24],
        eye: { height: 0.7, width: 0.3, spread: 0.42 },
        eyeColor: light ? "#f5f5f7" : void 0,
        decor: [
          {
            kind: "soft",
            boxes: [[-1.2, -0.3, 1.2, 1.2]],
            color: "#28d858",
            round: 0
          },
          {
            kind: "soft",
            boxes: [[-1.4, -1.7, 1.4, 0.45]],
            color: "#5be584",
            round: 1
          },
          {
            kind: "soft",
            boxes: [[-1.4, -1.7, 1.4, 0.34]],
            color: light ? "#161616" : "#f8f8f8",
            round: 1
          }
        ]
      }),
      copilot: spec({
        ownEyes: [
          [0.355, 0.57, 0.434, 0.723],
          [0.562, 0.57, 0.645, 0.723]
        ]
      })
    };
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-field.ts
  function colorField(artwork, holes) {
    const input = artwork.getContext("2d").getImageData(0, 0, 256, 256).data;
    const values = new Float32Array(60 * 60 * 3), known = new Uint8Array(60 * 60);
    let seen = 0;
    const low = [255, 255, 255], high = [0, 0, 0], sum = [0, 0, 0];
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 40; x++) {
        const source = (Math.floor((y + 0.5) * 256 / 40) * 256 + Math.floor((x + 0.5) * 256 / 40)) * 4;
        if (input[source + 3] <= 200 || holes.some(
          ([x0, y0, x1, y1]) => (x + 0.5) / 40 >= x0 && (x + 0.5) / 40 < x1 && (y + 0.5) / 40 >= y0 && (y + 0.5) / 40 < y1
        ))
          continue;
        const target = (y + 10) * 60 + x + 10;
        known[target] = 1;
        for (let channel = 0; channel < 3; channel++) {
          const value = input[source + channel];
          values[target * 3 + channel] = value;
          low[channel] = Math.min(low[channel], value);
          high[channel] = Math.max(high[channel], value);
          sum[channel] += value;
        }
        seen++;
      }
    if (!seen) return null;
    if (high.every((value, i) => value - low[i] < 14)) {
      const swatch = document.createElement("canvas");
      swatch.width = swatch.height = 1;
      const c2 = swatch.getContext("2d");
      c2.fillStyle = `rgb(${sum.map((value) => value / seen).join(",")})`;
      c2.fillRect(0, 0, 1, 1);
      return swatch;
    }
    for (let vertical = 0; vertical < 2; vertical++) {
      const filled = known.slice(), at = (line, offset) => vertical ? offset * 60 + line : line * 60 + offset;
      for (let row = 0; row < 60; row++) {
        let before = -1, position = 0;
        while (position < 60) {
          if (known[at(row, position)]) {
            before = position++;
            continue;
          }
          let after = position;
          while (after < 60 && !known[at(row, after)]) after++;
          if (before >= 0 || after < 60)
            for (let x = position; x < after; x++) {
              const from = before < 0 ? at(row, after) : at(row, before), to = after < 60 ? at(row, after) : from, share = before < 0 ? 1 : after >= 60 ? 0 : (x - before) / (after - before), index = at(row, x);
              for (let channel = 0; channel < 3; channel++)
                values[index * 3 + channel] = values[from * 3 + channel] * (1 - share) + values[to * 3 + channel] * share;
              filled[index] = 1;
            }
          position = after;
        }
      }
      known.set(filled);
    }
    const other = values.slice();
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < 60; y++)
        for (let x = 0; x < 60; x++)
          for (let ch = 0; ch < 3; ch++)
            other[(y * 60 + x) * 3 + ch] = (values[(y * 60 + Math.max(0, x - 1)) * 3 + ch] + values[(y * 60 + x) * 3 + ch] + values[(y * 60 + Math.min(59, x + 1)) * 3 + ch]) / 3;
      for (let y = 0; y < 60; y++)
        for (let x = 0; x < 60; x++)
          for (let ch = 0; ch < 3; ch++)
            values[(y * 60 + x) * 3 + ch] = (other[(Math.max(0, y - 1) * 60 + x) * 3 + ch] + other[(y * 60 + x) * 3 + ch] + other[(Math.min(59, y + 1) * 60 + x) * 3 + ch]) / 3;
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 60;
    const c = canvas.getContext("2d"), out = c.createImageData(60, 60);
    for (let i = 0; i < 3600; i++) {
      for (let ch = 0; ch < 3; ch++) out.data[i * 4 + ch] = values[i * 3 + ch];
      out.data[i * 4 + 3] = 255;
    }
    c.putImageData(out, 0, 0);
    return canvas;
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-form.ts
  function rounded(points, radius) {
    const path = new Path2D(), n = points.length;
    const middle = (a, b) => [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2
    ];
    const first = middle(points[n - 1], points[0]);
    path.moveTo(...first);
    points.forEach((point, index) => {
      const next = middle(point, points[(index + 1) % n]);
      path.arcTo(...point, ...next, radius);
      path.lineTo(...next);
    });
    path.closePath();
    return path;
  }
  function primitive(specification) {
    const s = specification, [cx, cy] = s.center, r = s.radius, shape = s.shape;
    const path = new Path2D();
    if (shape.kind === "circle" || shape.kind === "outline") {
      path.arc(cx, cy, r, 0, Math.PI * 2);
      return path;
    }
    if (shape.kind === "polygon")
      return rounded(
        Array.from({ length: shape.sides }, (_, i) => {
          const a = (shape.rotation + i * 360 / shape.sides) * Math.PI / 180;
          return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        }),
        shape.round
      );
    if (shape.kind === "rect") {
      const w = shape.width / 2, h = shape.height / 2, skew = (shape.skew ?? 0) / 2;
      return rounded(
        [
          [cx - w + skew, cy - h],
          [cx + w + skew, cy - h],
          [cx + w - skew, cy + h],
          [cx - w - skew, cy + h]
        ],
        shape.round
      );
    }
    if (shape.kind === "bob") {
      const at = (u, v) => [cx + u * r, cy + v * r];
      path.moveTo(...at(-1.14, 0.98));
      path.quadraticCurveTo(...at(-0.92, 0.72), ...at(-0.98, 0.3));
      for (let step = 0; step <= 48; step++) {
        const a = Math.PI + step / 48 * Math.PI;
        path.lineTo(...at(0.98 * Math.cos(a), -0.08 + 0.96 * Math.sin(a)));
      }
      path.lineTo(...at(0.98, 0.3));
      path.quadraticCurveTo(...at(0.92, 0.72), ...at(1.14, 0.98));
      path.lineTo(...at(0.62, 0.9));
      path.quadraticCurveTo(...at(0, 1.06), ...at(-0.62, 0.9));
      path.closePath();
      return path;
    }
    path.ellipse(cx, cy + 0.1 * r, 1.02 * r, 0.88 * r, 0, 0, Math.PI * 2);
    for (const side of [-1, 1]) {
      path.moveTo(cx + side * 0.94 * r, cy - 0.02 * r);
      path.lineTo(cx + side * 0.78 * r, cy - 1.04 * r);
      path.lineTo(cx + side * 0.16 * r, cy - 0.6 * r);
      path.closePath();
    }
    return path;
  }
  function reaches(pixels, center) {
    return Array.from({ length: 360 }, (_, i) => {
      const a = i * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
      let last = 0;
      for (let d = 0; d < 384; d++) {
        const x = Math.round(center[0] * 256 + dx * d), y = Math.round(center[1] * 256 + dy * d);
        if (x < 0 || y < 0 || x >= 256 || y >= 256) break;
        if (pixels[(y * 256 + x) * 4 + 3] > 127) last = d;
      }
      return Math.max(0.02, last / 256);
    });
  }
  function bodyReaches(s, logo2) {
    if (s.shape.kind === "circle") return Array(360).fill(s.radius);
    if (s.shape.kind === "outline") {
      let current = logo2;
      const width = s.shape.smooth;
      for (let pass = 0; pass < 2; pass++)
        current = current.map((_, i) => {
          let sum = 0;
          for (let off = -width; off <= width; off++)
            sum += current[(i + off + 360) % 360];
          return sum / (width * 2 + 1);
        });
      const mean = current.reduce((a, b) => a + b, 0) / 360, keep2 = s.shape.keep;
      return current.map(
        (value) => Math.max(s.radius * 0.55, s.radius * (1 + keep2 * (value / mean - 1)))
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const c = canvas.getContext("2d");
    c.scale(256, 256);
    c.fill(primitive(s));
    if (s.shape.kind === "cat") {
      c.lineJoin = "round";
      c.lineWidth = 0.16 * s.radius;
      const [cx, cy] = s.center;
      for (const side of [-1, 1]) {
        const p = new Path2D();
        p.moveTo(cx + side * 0.94 * s.radius, cy - 0.02 * s.radius);
        p.lineTo(cx + side * 0.78 * s.radius, cy - 1.04 * s.radius);
        p.lineTo(cx + side * 0.16 * s.radius, cy - 0.6 * s.radius);
        p.closePath();
        c.stroke(p);
      }
    }
    return reaches(c.getImageData(0, 0, 256, 256).data, s.center);
  }
  var cache = /* @__PURE__ */ new WeakMap();
  var specAliases = {
    "codebuddy-cn": "codebuddy",
    "qoder-cn": "qoder",
    "qoder-work": "qoder"
  };
  function makeForm(key, artwork, light) {
    let forms = cache.get(artwork);
    if (!forms) {
      forms = /* @__PURE__ */ new Map();
      cache.set(artwork, forms);
    }
    const cacheKey = key + String(light);
    if (forms.has(cacheKey)) return forms.get(cacheKey);
    const specs = botSpecs(light);
    const s = specs[key] ?? specs[specAliases[key]];
    if (!s) return null;
    const logo2 = reaches(
      artwork.getContext("2d").getImageData(0, 0, 256, 256).data,
      s.center
    );
    const body = bodyReaches(s, logo2);
    const highest = (ring) => Math.min(
      ...ring.map(
        (value, i) => s.center[1] + Math.sin(i * Math.PI / 180) * value
      )
    );
    let stripped = null;
    if (s.ownEyes) {
      stripped = document.createElement("canvas");
      stripped.width = stripped.height = 256;
      const c = stripped.getContext("2d");
      c.drawImage(artwork, 0, 0);
      for (const [x0, y0, x1, y1] of s.ownEyes)
        c.clearRect(
          x0 * 256 - 3,
          y0 * 256 - 3,
          (x1 - x0) * 256 + 6,
          (y1 - y0) * 256 + 6
        );
    }
    const form = {
      key,
      spec: s,
      artwork,
      field: colorField(artwork, s.unpainted ?? []),
      stripped,
      top: s.ownEyes ? highest(logo2) : highest(body) + (s.settle ?? 0),
      logoTop: highest(logo2),
      ink: light ? "#1d1d1f" : "#ffffff",
      logo: logo2,
      body,
      light
    };
    forms.set(cacheKey, form);
    return form;
  }
  var outlines = /* @__PURE__ */ new WeakMap();
  function formOutline(form, eased, turn) {
    const cached = outlines.get(form);
    if (cached?.eased === eased && cached.turn === turn) return cached.path;
    const path = new Path2D(), blend = eased, [cx, cy] = form.spec.center;
    for (let i = 0; i < 360; i++) {
      const sample = ((i - turn) % 360 + 360) % 360, low = Math.floor(sample), part = sample - low;
      const body = form.body[low] + (form.body[(low + 1) % 360] - form.body[low]) * part, r = form.logo[i] + (body - form.logo[i]) * blend, a = i * Math.PI / 180;
      if (!i) path.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      else path.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    path.closePath();
    outlines.set(form, { eased, turn, path });
    return path;
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-parts.ts
  var ink = "#0d0d0f";
  var rectWidth = (b) => b[2] - b[0];
  var rectHeight = (b) => b[3] - b[1];
  function roundBox(path, b, round) {
    path.roundRect(
      b[0],
      b[1],
      rectWidth(b),
      rectHeight(b),
      Math.min(rectWidth(b), rectHeight(b)) / 2 * round
    );
  }
  function boxesPath(boxes, round = 0) {
    const path = new Path2D();
    for (const box2 of boxes) roundBox(path, box2, round);
    return path;
  }
  function fillPaint(context, form, paint, origin = [0, 0]) {
    const s = form.spec, at = (point) => [
      origin[0] + s.center[0] + (point[0] - 0.5) * 2 * s.radius,
      origin[1] + s.center[1] + (point[1] - 0.5) * 2 * s.radius
    ];
    if (!paint) {
      if (form.field)
        context.drawImage(
          form.field,
          origin[0] - 0.25,
          origin[1] - 0.25,
          1.5,
          1.5
        );
      else {
        context.fillStyle = form.ink;
        context.fillRect(origin[0] - 0.3, origin[1] - 0.3, 1.6, 1.6);
      }
      return;
    }
    if (typeof paint === "string") context.fillStyle = paint;
    else {
      const gradient = "center" in paint ? context.createRadialGradient(
        ...at(paint.center),
        paint.inner * 2 * s.radius,
        ...at(paint.center),
        paint.outer * 2 * s.radius
      ) : context.createLinearGradient(...at(paint.from), ...at(paint.to));
      paint.colors.forEach(
        (color, i) => gradient.addColorStop(i / (paint.colors.length - 1), color)
      );
      context.fillStyle = gradient;
    }
    context.fillRect(origin[0] - 0.3, origin[1] - 0.3, 1.6, 1.6);
  }
  function decorate(context, item, s, offset, strength) {
    context.save();
    context.translate(s.center[0] + offset[0], s.center[1] + offset[1]);
    context.scale(s.radius, s.radius);
    context.globalAlpha = strength;
    if (item.kind === "blocks") {
      context.fillStyle = item.color;
      context.fill(boxesPath(item.boxes));
    } else if (item.kind === "cut") {
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = "#000";
      context.fill(boxesPath(item.boxes));
    } else if (item.kind === "notch" || item.kind === "line") {
      const p = new Path2D();
      item.points.forEach(
        (point, i) => i ? p.lineTo(...point) : p.moveTo(...point)
      );
      if (item.kind === "notch") {
        p.closePath();
        context.globalCompositeOperation = "destination-out";
        context.fillStyle = "#000";
        context.fill(p);
      } else {
        context.strokeStyle = ink;
        context.lineWidth = item.width;
        context.lineJoin = context.lineCap = "round";
        context.stroke(p);
      }
    }
    context.restore();
  }
  function wear(context, s, outline, strength) {
    for (const item of s.decor ?? [])
      if (item.kind === "soft") {
        context.save();
        context.clip(outline);
        context.translate(...s.center);
        context.scale(s.radius, s.radius);
        context.globalAlpha = strength;
        context.fillStyle = item.color;
        context.fill(boxesPath(item.boxes, item.round ?? 0));
        context.restore();
      }
  }
  function ringPath(s, grown, near) {
    const ring = s.ring, p = new Path2D(), r = s.radius, size = 0.5 + 0.5 * grown, tilt = ring.tilt * Math.PI / 180, sweep = near ? Math.PI : 2 * Math.PI;
    for (let step = 0; step <= 48; step++) {
      const a = sweep * step / 48, x = ring.radiusX * r * size * Math.cos(a), y = ring.radiusY * r * size * Math.sin(a), point = [
        s.center[0] + x * Math.cos(tilt) - y * Math.sin(tilt),
        s.center[1] + ring.drop * r + x * Math.sin(tilt) + y * Math.cos(tilt)
      ];
      if (step) p.lineTo(...point);
      else p.moveTo(...point);
    }
    if (!near) p.closePath();
    return p;
  }
  function spinner(path, frame, center, size) {
    const [spokes, length, width] = [
      [0, 0.24, 0.24],
      [4, 0.55, 0.2],
      [4, 0.85, 0.22],
      [6, 0.9, 0.2],
      [8, 1, 0.2],
      [8, 1, 0.28]
    ][frame - 1];
    if (!spokes) {
      path.rect(
        center[0] - length * size / 2,
        center[1] - length * size / 2,
        length * size,
        length * size
      );
      return;
    }
    for (let i = 0; i < spokes; i++) {
      const p = new Path2D(), w = width * size;
      p.roundRect(-w / 2, -w / 2, length * size + w, w, w / 2);
      path.addPath(
        p,
        new DOMMatrix().translate(...center).rotate(-90 + i * 360 / spokes)
      );
    }
  }
  function drawLimbs(context, form, stance2, strength) {
    const s = form.spec, limbs = s.limbs;
    if (!limbs) return;
    const pieces = [], step = limbs.pixel;
    for (const arm of limbs.arms) {
      const out = (arm[0] + arm[2]) / 2 < 0 ? -1 : 1, raised = out < 0 ? stance2.left : stance2.right, y = raised > 0 ? -step : 0;
      pieces.push([arm[0], arm[1] + y, arm[2], arm[3] + y]);
      if (raised > 1)
        pieces.push([
          arm[0] + out * rectWidth(arm),
          arm[1] - 2 * step,
          arm[2] + out * rectWidth(arm),
          arm[3] - 2 * step
        ]);
    }
    limbs.legs.forEach((leg, i) => {
      const lifted = stance2.lifted === 3 || stance2.lifted > 0 && i % 2 === stance2.lifted - 1, y = lifted ? -step / 2 : 0;
      pieces.push([leg[0], leg[1] + y, leg[2], leg[3] + y]);
    });
    const local = boxesPath(pieces);
    if (stance2.spinner > 0)
      spinner(local, stance2.spinner, [2.2 * step, -1 - 1.5 * step], 0.75 * step);
    const p = new Path2D();
    p.addPath(local, new DOMMatrix().translate(...s.center).scale(s.radius));
    context.save();
    context.clip(p);
    context.globalAlpha = strength;
    fillPaint(context, form, s.paint);
    context.restore();
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-eyes.ts
  function smile(context, half, stroke, paint, strength) {
    const rise = half * 0.95;
    context.globalAlpha = strength;
    context.strokeStyle = paint;
    context.lineWidth = stroke;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(-half, rise * 0.45);
    context.quadraticCurveTo(0, -rise * 1.1, half, rise * 0.45);
    context.stroke();
  }
  function pill(width, height, round) {
    const p = new Path2D(), corner = Math.min(width, height) / 2 * round;
    if (corner > 5e-4)
      p.roundRect(-width / 2, -height / 2, width, height, corner);
    else p.rect(-width / 2, -height / 2, width, height);
    return p;
  }
  function eyes(context, s, face, yaw, pitch, awake) {
    const r = s.radius, size = 0.78, spread = s.eye.spread, flat = s.eye.across, grain = s.limbs ? s.limbs.pixel / 2 : null, snapped = (v) => grain ? Math.round(v / grain) * grain : v, paint = s.eyeColor ?? ink, apart = flat !== void 0 ? 2 * flat * r : (Math.sin(yaw + spread) - Math.sin(yaw - spread)) * r * 0.76;
    for (const side of [-1, 1]) {
      const angle = flat === void 0 ? yaw + side * spread : 0, x = s.center[0] + s.face[0] * r + (flat !== void 0 ? side * flat * r + snapped(Math.sin(yaw) * 0.76) * r : Math.sin(angle) * r * 0.76), y = s.center[1] + s.face[1] * r + (flat === void 0 ? Math.sin(pitch) * 0.62 : snapped(Math.sin(pitch) * 0.62)) * r, narrow = Math.max(0.25, Math.cos(angle)) ** 1.4, tall = (0.72 + 0.28 * Math.cos(angle)) * Math.sqrt(Math.cos(pitch)), big = (1 + 0.26 * side * face.lean) * face.wide * (0.6 + 0.4 * awake) * size, width = s.eye.width * r * big * narrow, height = s.eye.height * r * big * tall * Math.max(0.08, face.open) * awake;
      context.save();
      context.translate(x, y);
      if (face.happy < 0.98 && face.crossed < 0.98) {
        context.globalAlpha = (1 - face.happy) * (1 - face.crossed);
        context.fillStyle = paint;
        context.fill(pill(width, Math.max(height, width * 0.16), s.eye.round));
        if (s.pupil && height > width * 0.45) {
          context.fillStyle = s.pupil;
          const across = width * 0.21, down = Math.min(height, width) * 0.21;
          context.beginPath();
          context.ellipse(
            face.look * width * 0.2,
            face.lookY * height * 0.2 - height * 0.06,
            across,
            down,
            0,
            0,
            2 * Math.PI
          );
          context.fill();
        }
      }
      if (face.crossed > 0.02) {
        const reach = s.eye.height * r * size * 0.32 * (0.6 + 0.4 * awake);
        context.globalAlpha = face.crossed;
        context.strokeStyle = paint;
        context.lineWidth = s.eye.width * r * size * 0.55;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(-reach, -reach);
        context.lineTo(reach, reach);
        context.moveTo(-reach, reach);
        context.lineTo(reach, -reach);
        context.stroke();
      }
      if (face.happy > 0.02) {
        const stroke = Math.min(s.eye.width * r * 0.58 * size, apart * 0.2), half = Math.max(
          stroke * 0.7,
          Math.min(s.eye.width * r * 0.8 * size, apart / 2 - stroke * 1.05)
        ) * Math.max(0.6, narrow);
        smile(context, half, stroke, paint, face.happy);
      }
      context.restore();
    }
  }
  function ownEyes(context, boxes, face, ink2) {
    const center = (b) => (b[0] + b[2]) / 2, middle = (center(boxes[0]) + center(boxes.at(-1))) / 2, apart = Math.abs(center(boxes.at(-1)) - center(boxes[0]));
    for (const b of boxes) {
      const side = center(b) > middle ? 1 : -1, big = (1 + 0.26 * side * face.lean) * face.wide, width = rectWidth(b) * big, height = rectHeight(b) * big * Math.max(0.06, face.open);
      context.save();
      context.translate(
        center(b) + Math.min(0.04, rectWidth(b) * 0.45) * face.look,
        (b[1] + b[3]) / 2 + Math.min(0.03, rectHeight(b) * 0.14) * face.lookY
      );
      if (face.happy < 0.98) {
        context.globalAlpha = 1 - face.happy;
        context.fillStyle = ink2;
        context.fill(pill(width, Math.max(height, width * 0.16), 1));
      }
      if (face.happy > 0.02)
        smile(
          context,
          Math.min(rectWidth(b) * 0.95, apart * 0.3),
          Math.min(rectWidth(b) * 0.6, apart * 0.2),
          ink2,
          face.happy
        );
      context.restore();
    }
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-fins.ts
  function finPath(fin, grown, raised) {
    const angle = (fin.angle - fin.hand * raised) * Math.PI / 180, along = [Math.cos(angle), Math.sin(angle)], across = [Math.sin(angle), -Math.cos(angle)], length = fin.length * grown, a = fin.root, ra = fin.base * grown, rb = fin.tip * grown, b = [
      a[0] + along[0] * (length - rb) + across[0] * fin.sweep * grown,
      a[1] + along[1] * (length - rb) + across[1] * fin.sweep * grown
    ], dx = b[0] - a[0], dy = b[1] - a[1], d = Math.max(1e-6, Math.hypot(dx, dy)), s = Math.max(-1, Math.min(1, (ra - rb) / d)), c = Math.sqrt(1 - s * s), toward = Math.atan2(dy, dx), spread = Math.atan2(c, s), path = new Path2D();
    let empty = true;
    const arc = (center, radius, start, end) => {
      const count = Math.max(2, Math.ceil((end - start) / (Math.PI / 16)));
      for (let i = 0; i <= count; i++) {
        const a2 = start + (end - start) * i / count, x = center[0] + radius * Math.cos(a2), y = center[1] + radius * Math.sin(a2);
        if (empty) {
          path.moveTo(x, y);
          empty = false;
        } else path.lineTo(x, y);
      }
    };
    arc(b, rb, toward - spread, toward + spread);
    arc(a, ra, toward + spread, toward + 2 * Math.PI - spread);
    path.closePath();
    return path;
  }
  function finSilhouette(spec2) {
    const path = new Path2D();
    let any = false;
    for (const item of spec2.decor ?? [])
      if (item.kind === "fins")
        for (const fin of item.fins) {
          path.addPath(
            finPath(fin, 1, 0),
            new DOMMatrix().translate(...spec2.center).scale(spec2.radius)
          );
          any = true;
        }
    return any ? path : null;
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-still.ts
  var BotStill = class _BotStill {
    constructor(form, morph2, turn, helper, flap, context) {
      this.context = context;
      const t = context.getTransform();
      this.key = {
        form,
        width: context.canvas.width,
        height: context.canvas.height,
        transform: [t.a, t.b, t.c, t.d, t.e, t.f].join(","),
        morph: morph2,
        turn,
        helper,
        flap: `${flap.left},${flap.right}`
      };
    }
    static slots = [];
    key;
    slot() {
      const key = this.key, index = _BotStill.slots.findIndex(
        (s) => s.form === key.form && s.width === key.width && s.height === key.height && s.transform === key.transform
      );
      if (index < 0) return null;
      const slot = _BotStill.slots.splice(index, 1)[0];
      _BotStill.slots.push(slot);
      return slot;
    }
    same(slot) {
      const k = this.key;
      return slot.morph === k.morph && slot.turn === k.turn && slot.helper === k.helper && slot.flap === k.flap;
    }
    restore() {
      const slot = this.slot();
      if (!slot?.bytes || !this.same(slot)) return false;
      this.context.putImageData(slot.bytes, 0, 0);
      return true;
    }
    keep() {
      const slot = this.slot();
      if (!slot) {
        if (_BotStill.slots.length >= 36) _BotStill.slots.shift();
        _BotStill.slots.push({ ...this.key, bytes: null });
        return;
      }
      if (!this.same(slot)) {
        Object.assign(slot, this.key, { bytes: null });
        return;
      }
      slot.bytes = this.context.getImageData(
        0,
        0,
        this.key.width,
        this.key.height
      );
    }
    static forget() {
      this.slots = [];
    }
  };

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-body.ts
  var cut = (form) => form.light ? "#f5f5f7" : ink;
  var morph = (share) => ({
    share,
    eased: easeInOut(share),
    solid: Math.min(1, share / 0.22),
    dressed: Math.max(0, Math.min(1, (share - 0.45) / 0.45))
  });
  function stillPart(context, form, m, turn, decor, helper = false, flap = { left: 0, right: 0 }) {
    const s = form.spec, [cx, cy] = s.center, r = s.radius, artwork = 1 - Math.min(1, m.share / 0.4);
    if (artwork > 0) {
      context.globalAlpha = artwork;
      context.drawImage(form.artwork, 0, 0, 1, 1);
    }
    context.translate(0, (s.settle ?? 0) * m.eased);
    const path = formOutline(form, m.eased, turn), ringShare = s.ring ? Math.max(0, Math.min(1, (m.share - 0.5) / 0.5)) : 0;
    if (s.ring && ringShare > 0) {
      context.globalAlpha = ringShare;
      context.strokeStyle = form.ink;
      context.lineWidth = s.ring.width * r;
      context.lineCap = "round";
      context.stroke(ringPath(s, ringShare, false));
    }
    for (const item of s.decor ?? [])
      if (m.dressed > 0 && (item.kind === "feelers" || item.kind === "fins")) {
        context.save();
        context.translate(cx, cy);
        context.scale(r, r);
        context.globalAlpha = m.dressed;
        if (item.kind === "feelers") {
          context.strokeStyle = item.color;
          context.lineWidth = item.width;
          context.lineJoin = context.lineCap = "round";
          context.beginPath();
          for (const line of item.lines)
            line.forEach(
              (p, i) => i ? context.lineTo(...p) : context.moveTo(...p)
            );
          context.stroke();
        } else {
          context.fillStyle = item.color;
          const p = new Path2D(), grown = 0.3 + 0.7 * m.dressed;
          for (const fin of item.fins)
            p.addPath(
              finPath(
                fin,
                grown,
                fin.hand < 0 ? flap.left : fin.hand > 0 ? flap.right : 0
              )
            );
          context.fill(p);
        }
        context.restore();
      }
    context.globalAlpha = m.solid;
    context.save();
    context.clip(path);
    fillPaint(context, form, s.paint);
    if (s.patch) {
      const b = s.patch.box, width = rectWidth(b) * r, height = rectHeight(b) * r, corner = Math.min(s.patch.round * r, Math.min(width, height) / 2), px = cx + (b[0] + b[2]) / 2 * r, py = cy + (b[1] + b[3]) / 2 * r;
      context.save();
      context.translate(px, py);
      context.scale(0.4 + 0.6 * m.eased, 0.4 + 0.6 * m.eased);
      context.globalAlpha = m.solid * Math.max(0, Math.min(1, (m.share - 0.2) / 0.4));
      const p = new Path2D();
      p.roundRect(-width / 2, -height / 2, width, height, corner);
      context.clip(p);
      fillPaint(context, form, s.patch.paint, [-px, -py]);
      context.restore();
    }
    if (s.stroke) {
      context.strokeStyle = s.stroke;
      context.lineWidth = 0.07;
      context.lineJoin = "round";
      context.stroke(path);
    }
    context.restore();
    if (s.ring && ringShare > 0) {
      context.save();
      context.clip(path);
      context.globalAlpha = ringShare;
      context.strokeStyle = cut(form);
      context.lineWidth = s.ring.width * r;
      context.lineCap = "butt";
      context.stroke(ringPath(s, ringShare, true));
      context.restore();
    }
    if (!s.keeps && m.dressed > 0) {
      wear(context, s, path, m.dressed);
      for (const item of (s.decor ?? []).slice(0, decor))
        decorate(context, item, s, [0, 0], m.dressed);
    }
    if (helper && m.dressed > 0) drawHelper(context, form, m.dressed);
  }
  function drawHelper(context, form, strength) {
    const s = form.spec, scale = 0.4;
    context.save();
    context.translate(s.center[0] + 0.42, s.center[1] + 0.18);
    context.scale(scale, scale);
    context.translate(-s.center[0], -s.center[1]);
    context.globalAlpha = strength;
    if (s.ownEyes) {
      context.save();
      context.translate(0.5, 0.5);
      context.scale(1 + 0.035 * 2 / scale, 1 + 0.035 * 2 / scale);
      context.translate(-0.5, -0.5);
      context.globalCompositeOperation = "destination-out";
      context.drawImage(form.artwork, 0, 0, 1, 1);
      context.restore();
      context.drawImage(form.artwork, 0, 0, 1, 1);
    } else {
      const path = formOutline(form, 1, 0);
      context.save();
      context.globalCompositeOperation = "destination-out";
      context.strokeStyle = "#000";
      context.lineWidth = 0.035 * 2 / scale;
      context.lineJoin = "round";
      const gap = new Path2D();
      gap.addPath(path);
      const fins = finSilhouette(s);
      if (fins) gap.addPath(fins);
      context.stroke(gap);
      context.restore();
      group(context, strength, (c) => {
        c.save();
        stillPart(c, form, morph(1), 0, (s.decor ?? []).length);
        c.restore();
        drawLimbs(c, form, botLimbs(), 1);
        eyes(c, s, botFace(), 0, 0, 1);
      });
    }
    context.restore();
  }
  function drawBody(context, form, motion, cache2) {
    const s = form.spec, m = morph(motion.morph), decor = s.decor ?? [], first = decor.findIndex((item) => item.kind === "blocks" && item.follows), settled = s.keeps ? 0 : first < 0 ? decor.length : first, still = cache2 ? new BotStill(
      form,
      m.share,
      motion.turn,
      motion.helper,
      motion.flap,
      context
    ) : null;
    if (!still?.restore()) {
      context.save();
      stillPart(
        context,
        form,
        m,
        motion.turn,
        settled,
        motion.helper,
        motion.flap
      );
      context.restore();
      still?.keep();
    }
    context.translate(0, (s.settle ?? 0) * m.eased);
    if (s.keeps) {
      const b = s.keeps, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      context.save();
      context.globalAlpha = m.solid;
      context.translate(cx, cy - motion.kept.lift);
      context.scale(motion.kept.scale, motion.kept.scale);
      context.translate(-cx, -cy);
      const p = new Path2D();
      p.rect(b[0] - 0.01, b[1] - 0.01, rectWidth(b) + 0.02, rectHeight(b) + 0.02);
      context.clip(p);
      context.drawImage(form.artwork, 0, 0, 1, 1);
      context.restore();
    }
    if (m.dressed <= 0) return;
    drawLimbs(context, form, motion.limbs, m.dressed);
    const face = motion.face, turn = s.reach * 0.72, yaw = Math.max(-1.15, Math.min(1.15, face.look)) * turn, pitch = Math.max(-1.15, Math.min(1.15, face.lookY)) * turn, glance = [
      Math.sin(yaw) * s.radius * 0.72,
      Math.sin(pitch) * s.radius * 0.62
    ];
    if (s.keeps)
      wear(context, s, formOutline(form, m.eased, motion.turn), m.dressed);
    for (const item of decor.slice(settled))
      decorate(
        context,
        item,
        s,
        item.kind === "blocks" && item.follows ? glance : [0, 0],
        m.dressed
      );
    eyes(context, s, face, yaw, pitch, m.dressed);
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/bot-renderer.ts
  var box = [0, 0, 1, 1];
  function botRenderLook(motion) {
    const f = motion.face, s = (v, steps) => Math.round(v * steps);
    return JSON.stringify([
      s(motion.morph, 60),
      s(motion.turn, 0.5),
      s(f.open, 40),
      s(f.look, 50),
      s(f.lookY, 50),
      s(f.wide, 50),
      s(f.happy, 30),
      s(f.lean, 30),
      s(f.crossed, 30),
      s(motion.kept.lift, 300),
      s(motion.kept.scale, 60),
      motion.limbs,
      motion.flap,
      motion.sign,
      motion.lit,
      motion.helper
    ]);
  }
  function bare(context, form, motion, cache2 = false) {
    if (form.spec.ownEyes) {
      context.globalAlpha = 1 - motion.morph;
      context.drawImage(form.artwork, ...box);
      if (motion.morph > 0) {
        group(
          context,
          motion.morph,
          (c) => {
            c.drawImage(form.stripped ?? form.artwork, ...box);
            ownEyes(c, form.spec.ownEyes, motion.face, form.ink);
          },
          "lighter"
        );
        if (motion.helper) drawHelper(context, form, motion.morph);
      }
    } else drawBody(context, form, motion, cache2);
  }
  function canvasFor(side, outline, into) {
    const inner = Math.ceil(side * 1.6), canvas = reuseCanvas(into, inner + outline * 2, inner + outline * 2);
    const context = canvas.getContext("2d"), unit = inner / 1.6;
    context.translate(outline + 0.3 * unit, outline + 0.3 * unit);
    context.scale(unit, unit);
    context.imageSmoothingEnabled = true;
    return { canvas, context };
  }
  function renderBot(form, motion, side, outline = 0, into) {
    const { canvas, context } = canvasFor(side, outline, into);
    context.save();
    bare(context, form, motion, true);
    context.restore();
    context.resetTransform();
    if (motion.sign)
      paintSign(
        context,
        motion.sign,
        signBox(form, side, outline),
        form.light,
        motion.lit,
        motion.sign === "ellipsis" || motion.sign === "z" ? morph(motion.morph).dressed : 1
      );
    if (outline > 0) layHairline(context, outline, form.light);
    return canvas;
  }
  function renderLogo(form, sign, side, outline = 0) {
    const { canvas, context } = canvasFor(side, outline);
    context.drawImage(form.artwork, 0, 0, 1, 1);
    context.resetTransform();
    if (sign) paintSign(context, sign, signBox(form, side, outline), form.light);
    if (outline > 0) layHairline(context, outline, form.light);
    return canvas;
  }

  // ../ext-hud/repo/src/packages/hud/src/bots/mark-painter.ts
  var clock = () => performance.now() / 1e3;
  function paintMark(canvas, ctx, {
    actor,
    key,
    light,
    artwork,
    form,
    sheet,
    props,
    localAim,
    onReady
  }) {
    let disposed = false, timer;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let imageKey = "", image = null;
    let paintedKey = "", layoutKey = "", placed2 = "", opacity = -1, announced = false, scheduledDue = Infinity;
    const logos = /* @__PURE__ */ new Map();
    const cancelTimer = () => {
      clearTimeout(timer);
      timer = void 0;
      scheduledDue = Infinity;
    };
    const arm = (due) => {
      if (!Number.isFinite(due)) {
        cancelTimer();
        return;
      }
      if (timer !== void 0 && due === scheduledDue) return;
      cancelTimer();
      scheduledDue = due;
      timer = setTimeout(
        () => {
          timer = void 0;
          scheduledDue = Infinity;
          step();
        },
        Math.max(1, (due - clock()) * 1e3)
      );
    };
    const step = () => {
      if (disposed) return;
      if (document.hidden) {
        cancelTimer();
        return;
      }
      const now = clock(), input = props.current, aim = input.parentAim ?? localAim.current;
      const scale = devicePixelRatio || 1, side = input.size * scale, hair = input.outline * scale, pad = key === "claude" ? Math.ceil(side * 0.3) : 0, extent = Math.ceil(side * 1.6) + hair * 2 + pad * 2;
      const layout = `${side}:${scale}:${hair}:${extent}`;
      const still = media.matches || !input.enabled || !form;
      const sprites = Boolean(
        key === "claude" && sheet && drawsClawdSprites(input.size, scale)
      );
      if (!still) actor.selectRenderer(sprites ? "clawd" : "procedural");
      if (layout !== layoutKey) {
        layoutKey = layout;
        actor.invalidate();
        if (canvas.width !== extent || canvas.height !== extent)
          canvas.width = canvas.height = extent;
        const cssExtent = `${extent / scale}px`, cssOffset = `${-(extent / scale - input.size) / 2}px`;
        canvas.style.width = canvas.style.height = cssExtent;
        canvas.style.left = canvas.style.top = cssOffset;
        paintedKey = "";
        imageKey = "";
        logos.clear();
      }
      if (!still && now < actor.due - 4e-3) {
        arm(actor.due);
        return;
      }
      const result = still ? null : actor.step(now, aim, sprites ? "clawd" : "procedural");
      const frame = result?.frame ?? null;
      const look = still ? `still:${stillSign(actor.state)}` : sprites && frame ? `clawd:${JSON.stringify([frame.front, frame.back, frame.frontOpacity, frame.backOpacity, frame.opacity])}` : `body:${botRenderLook(actor.motion)}`;
      const nextPaint = `${layout}:${look}`;
      const pose = !still && !sprites ? actor.motion.pose : null;
      const transform = pose ? `translate(${pose.x * input.size}px, ${(pose.y + pose.footing) * input.size}px) rotate(${pose.rotation}deg) scale(${pose.scaleX}, ${pose.scaleY}) translateY(${-pose.footing * input.size}px)` : "none";
      const alpha = !still && !sprites ? actor.motion.opacity : 1;
      if (transform !== placed2) {
        canvas.style.transform = transform;
        placed2 = transform;
      }
      if (alpha !== opacity) {
        canvas.style.opacity = String(alpha);
        opacity = alpha;
      }
      if (nextPaint !== paintedKey) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, extent, extent);
        ctx.globalAlpha = 1;
        const drawLogo = (sign) => {
          if (form) {
            const key2 = sign ?? "logo";
            let logo2 = logos.get(key2);
            if (!logo2) {
              logo2 = renderLogo(form, sign, side, hair);
              logos.set(key2, logo2);
            }
            ctx.drawImage(logo2, pad, pad);
          } else {
            ctx.drawImage(
              artwork,
              pad + hair + side * 0.3,
              pad + hair + side * 0.3,
              side,
              side
            );
            if (sign) {
              const mark = stillSignImage(sign, null, input.size, scale, light);
              ctx.drawImage(
                mark.image,
                pad + hair + side * 0.3 + mark.frame.x * scale,
                pad + hair + side * 0.3 + mark.frame.y * scale
              );
            }
          }
        };
        if (still) drawLogo(stillSign(actor.state));
        else if (sprites && frame) {
          const draw = (seen, alpha2) => {
            if (alpha2 <= 0) return;
            ctx.globalAlpha = alpha2 * frame.opacity;
            const baked = seen.picture && actor.clawd.baker?.image(
              seen.picture,
              input.size,
              scale,
              extent,
              light,
              hair
            );
            if (baked) ctx.drawImage(baked, 0, 0);
            else drawLogo(seen.sign ?? null);
          };
          if (frame.back) draw(frame.back, frame.backOpacity);
          draw(frame.front, frame.frontOpacity);
          ctx.globalAlpha = 1;
        } else if (form) {
          const next = `${botRenderLook(actor.motion)}:${side}:${hair}`;
          if (next !== imageKey) {
            image = renderBot(form, actor.motion, side, hair, image ?? void 0);
            imageKey = next;
          }
          if (image) ctx.drawImage(image, pad, pad);
        }
        paintedKey = nextPaint;
      }
      if (!announced) {
        announced = true;
        onReady();
      }
      if (still) cancelTimer();
      else arm(result.due);
    };
    const resume = () => {
      step();
    };
    const resourceChanged = () => {
      actor.invalidate();
      step();
    };
    const wake = (aimOnly = false) => {
      if (aimOnly && (media.matches || !props.current.enabled || !form || clock() < actor.due - 4e-3))
        return;
      step();
    };
    media.addEventListener("change", resourceChanged);
    window.addEventListener("resize", resume);
    document.addEventListener("visibilitychange", resume);
    step();
    return {
      wake,
      dispose() {
        disposed = true;
        clearTimeout(timer);
        media.removeEventListener("change", resourceChanged);
        window.removeEventListener("resize", resume);
        document.removeEventListener("visibilitychange", resume);
      }
    };
  }

  // src/entry.ts
  function tintFor(key, light) {
    if (key === "openai") return "#10a37f";
    if (key === "grok") return light ? "#1d1d1f" : "#ffffff";
    return null;
  }
  var images = /* @__PURE__ */ new Map();
  function loadArtwork(url, key, light) {
    let loading = images.get(url);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("artwork " + key));
        image.src = url;
      });
      images.set(url, loading);
    }
    return loading.then((image) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, 256, 256);
      const tint = tintFor(key, light);
      if (tint) {
        context.globalCompositeOperation = "source-in";
        context.fillStyle = tint;
        context.fillRect(0, 0, 256, 256);
        context.globalCompositeOperation = "source-over";
      }
      return canvas;
    });
  }
  function mount(host, options) {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    canvas.style.visibility = "hidden";
    host.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const actor = new BotActor(botState(options.state), clock(), {});
    const props = { current: { size: options.size, enabled: !options.still, outline: 0 } };
    const localAim = { current: [0, 0] };
    let painter;
    let disposed = false;
    loadArtwork(options.url, options.key, options.light).then((artwork) => {
      if (disposed) return;
      const form = makeForm(options.key, artwork, options.light);
      if (form) actor.fit(form);
      painter = paintMark(canvas, ctx, {
        actor,
        key: options.key,
        light: options.light,
        artwork,
        form,
        sheet: null,
        props,
        localAim,
        onReady: () => {
          canvas.style.visibility = "";
          host.dataset.ready = "1";
        }
      });
    }).catch((error) => {
      host.dataset.failed = String(error && (error.stack || error.message) || error).slice(0, 300);
    });
    const aim = (event) => {
      const rect = host.getBoundingClientRect();
      const clamp = (v) => Math.max(-1, Math.min(1, v));
      localAim.current = [
        clamp((event.clientX - rect.x - rect.width / 2) / Math.max(1, rect.width)),
        clamp((event.clientY - rect.y - rect.height / 2) / Math.max(1, rect.height))
      ];
      painter?.wake(true);
    };
    const enter = () => {
      actor.set(botState({ ...options.state, hovered: true }), clock());
      painter?.wake();
    };
    const leave = () => {
      actor.set(botState(options.state), clock());
      painter?.wake();
    };
    if (!options.still) {
      host.addEventListener("pointermove", aim);
      host.addEventListener("pointerenter", enter);
      host.addEventListener("pointerleave", leave);
    }
    return {
      set(state, cue) {
        options.state = state;
        const now = clock();
        const changed = actor.set(botState(state), now);
        const played2 = cue ? actor.playCue(cue, now) : false;
        if (changed || played2) painter?.wake();
      },
      clock,
      dispose() {
        disposed = true;
        painter?.dispose();
        host.removeEventListener("pointermove", aim);
        host.removeEventListener("pointerenter", enter);
        host.removeEventListener("pointerleave", leave);
        canvas.remove();
      }
    };
  }
  return __toCommonJS(entry_exports);
})();
