/*
  Driving controls.

  Keyboard and gamepad are read into one shape the simulation understands, so the sim never
  learns what a key is. Reading rather than eventing matters for a fixed-step sim: the step
  wants to know what is held down NOW, several times per frame if the clock has fallen behind,
  and an event queue cannot answer that without being replayed.

  The bindings follow the game where the game has an opinion. MONSTER.INI names keyNextView,
  keyCockpitView, keyCamera and the four keyViewNNN entries, and the README says V cycles
  views while Ctrl+1 returns to the cockpit, so those are what this uses. Arrow keys drive,
  which is MTM2's default and also what the fly camera used, so drive mode takes them over
  while it is active and hands them back when it is not.
*/

const THROTTLE_KEYS = ["ArrowUp", "KeyW"];
const BRAKE_KEYS = ["ArrowDown", "KeyS"];
const LEFT_KEYS = ["ArrowLeft", "KeyA"];
const RIGHT_KEYS = ["ArrowRight", "KeyD"];
const HANDBRAKE_KEYS = ["Space"];

/*
  Standard Gamepad mapping, which is what a browser reports for anything Xbox shaped:
  axis 0 is the left stick's x, buttons 6 and 7 are the triggers, and a trigger reports its
  travel in `value` rather than only as a press.
*/
const PAD_STEER_AXIS = 0;
const PAD_BRAKE_BUTTON = 6;
const PAD_THROTTLE_BUTTON = 7;
const PAD_HANDBRAKE_BUTTON = 0;
const PAD_VIEW_BUTTON = 3;
const PAD_RESET_BUTTON = 1;
const STICK_DEADZONE = 0.12;

export function createDriveInput(element) {
  const held = new Set();
  // Edge-triggered actions: pressing V should cycle one view, not one per frame.
  const pressed = [];
  let padViewWasDown = false;
  let padResetWasDown = false;
  let enabled = false;

  const onKeyDown = (event) => {
    if (!enabled) return;
    const code = event.code || event.key;
    /*
      Ctrl+1 is the game's "back to the cockpit", and it has to be tested before the plain
      Digit1 binding or the modifier would be ignored.
    */
    if (code === "Digit1" && event.ctrlKey) {
      pressed.push("cockpitView");
      event.preventDefault();
      return;
    }
    if (!held.has(code)) {
      if (code === "KeyV") pressed.push("nextView");
      if (code === "KeyR") pressed.push("reset");
      if (code === "KeyC") pressed.push("freeCamera");
    }
    held.add(code);
    // The arrows and space scroll the page otherwise, which is disorienting mid-jump.
    if (THROTTLE_KEYS.includes(code) || BRAKE_KEYS.includes(code)
      || LEFT_KEYS.includes(code) || RIGHT_KEYS.includes(code)
      || HANDBRAKE_KEYS.includes(code)) {
      event.preventDefault();
    }
  };

  const onKeyUp = (event) => held.delete(event.code || event.key);
  // Losing focus mid-corner otherwise leaves the throttle pinned.
  const onBlur = () => held.clear();

  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("keyup", onKeyUp);
  element.addEventListener("blur", onBlur);
  window.addEventListener("blur", onBlur);

  const anyHeld = (codes) => codes.some((code) => held.has(code));

  function readPad() {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (pad?.connected) return pad;
    }
    return null;
  }

  return {
    setEnabled(value) {
      enabled = value;
      if (!value) {
        held.clear();
        pressed.length = 0;
      }
    },

    get enabled() { return enabled; },

    /** The current control positions, plus any one-shot actions since the last read. */
    read() {
      let throttle = anyHeld(THROTTLE_KEYS) ? 1 : 0;
      let brake = anyHeld(BRAKE_KEYS) ? 1 : 0;
      let steer = (anyHeld(RIGHT_KEYS) ? 1 : 0) - (anyHeld(LEFT_KEYS) ? 1 : 0);
      let handbrake = anyHeld(HANDBRAKE_KEYS);

      const pad = enabled ? readPad() : null;
      if (pad) {
        // A pad only overrides an axis the driver is actually using, so a keyboard and a pad
        // can be mixed without one zeroing the other.
        const padThrottle = pad.buttons[PAD_THROTTLE_BUTTON]?.value ?? 0;
        const padBrake = pad.buttons[PAD_BRAKE_BUTTON]?.value ?? 0;
        const rawSteer = pad.axes[PAD_STEER_AXIS] ?? 0;
        const padSteer = Math.abs(rawSteer) > STICK_DEADZONE
          ? (rawSteer - Math.sign(rawSteer) * STICK_DEADZONE) / (1 - STICK_DEADZONE)
          : 0;

        if (padThrottle > 0.02) throttle = padThrottle;
        if (padBrake > 0.02) brake = padBrake;
        if (padSteer !== 0) steer = padSteer;
        if (pad.buttons[PAD_HANDBRAKE_BUTTON]?.pressed) handbrake = true;

        // Buttons are polled, so the edge has to be found here rather than in a listener.
        const viewDown = !!pad.buttons[PAD_VIEW_BUTTON]?.pressed;
        if (viewDown && !padViewWasDown) pressed.push("nextView");
        padViewWasDown = viewDown;

        const resetDown = !!pad.buttons[PAD_RESET_BUTTON]?.pressed;
        if (resetDown && !padResetWasDown) pressed.push("reset");
        padResetWasDown = resetDown;
      }

      const actions = pressed.slice();
      pressed.length = 0;
      return {
        throttle,
        brake: Math.max(brake, handbrake ? 1 : 0),
        steer: Math.max(-1, Math.min(1, steer)),
        handbrake,
        actions,
      };
    },

    dispose() {
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("keyup", onKeyUp);
      element.removeEventListener("blur", onBlur);
      window.removeEventListener("blur", onBlur);
    },
  };
}
