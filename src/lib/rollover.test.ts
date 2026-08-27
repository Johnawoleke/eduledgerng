import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { movingEnrolmentFilter, selectMoving, type EnrolmentRow } from "./rollover";
import { nextClass, OUTCOME_STATUS } from "./classes";

describe("who moves when a class moves up", () => {
  it("never keys the filter on anything but the enrolment's own columns", () => {
    // students.class is the pupil's class NOW and is updated by a move, so it
    // is the cascade. If it ever appears here, moving classes in order
    // double-promotes and nothing on screen says so.
    const filter = movingEnrolmentFilter("session-a", "Nursery 1");
    expect(Object.keys(filter).sort()).toEqual(["class", "session_id", "status"]);
    expect(filter.status).toBe("active");
    expect(filter.session_id).toBe("session-a");
  });

  it("takes the whole session when no class is named", () => {
    expect(movingEnrolmentFilter("session-a", null)).toEqual({
      session_id: "session-a",
      status: "active",
    });
  });

  it("ignores an enrolment that has already been resolved", () => {
    const rows: EnrolmentRow[] = [
      { student_id: "a", session_id: "s1", class: "JSS1", status: "active" },
      { student_id: "b", session_id: "s1", class: "JSS1", status: "promoted" },
      { student_id: "c", session_id: "s1", class: "JSS1", status: "graduated" },
    ];
    expect(selectMoving(rows, "s1", "JSS1").map((r) => r.student_id)).toEqual(["a"]);
  });

  it("ignores an enrolment in a different session", () => {
    const rows: EnrolmentRow[] = [
      { student_id: "a", session_id: "s1", class: "JSS1", status: "active" },
      { student_id: "b", session_id: "s2", class: "JSS1", status: "active" },
    ];
    expect(selectMoving(rows, "s1", "JSS1").map((r) => r.student_id)).toEqual(["a"]);
  });
});

// The sequence a school owner actually performs, played out against an
// in-memory store that writes exactly what promote-session writes. This is the
// regression test for the question "if I move Nursery 1 up and then move
// Nursery 2 up, do the Nursery 1 pupils end up in Nursery 3?"
describe("moving one class at a time, in ladder order", () => {
  const FROM = "2025/2026";
  const TO = "2026/2027";

  interface Pupil { id: string; class: string; status: string }

  const school = () => {
    const pupils: Pupil[] = [
      { id: "n1-a", class: "Nursery 1", status: "active" },
      { id: "n1-b", class: "Nursery 1", status: "active" },
      { id: "n2-a", class: "Nursery 2", status: "active" },
    ];
    const enrolments: EnrolmentRow[] = pupils.map((p) => ({
      student_id: p.id, session_id: FROM, class: p.class, status: "active",
    }));

    // The writes promote-session makes on commit, in the same order.
    const moveClassUp = (className: string) => {
      const moving = selectMoving(enrolments, FROM, className);
      for (const e of moving) {
        const up = nextClass(e.class);
        const already = enrolments.some(
          (x) => x.student_id === e.student_id && x.session_id === TO
        );
        if (up && !already) {
          enrolments.push({ student_id: e.student_id, session_id: TO, class: up, status: "active" });
          // The roster follows the placement, which is what makes the naive
          // implementation look correct right up until the second move.
          const pupil = pupils.find((p) => p.id === e.student_id)!;
          pupil.class = up;
        }
        e.status = OUTCOME_STATUS.promote;
      }
      return moving.length;
    };

    return { pupils, enrolments, moveClassUp };
  };

  it("does not carry the pupils you just moved into the next move", () => {
    const { pupils, moveClassUp } = school();

    expect(moveClassUp("Nursery 1")).toBe(2);

    // The roster now shows THREE pupils in Nursery 2: the pupil who spent the
    // year there, plus the two just moved in. This is the trap — the screen
    // says three, and a naive move would take all three.
    expect(pupils.filter((p) => p.class === "Nursery 2").map((p) => p.id).sort())
      .toEqual(["n1-a", "n1-b", "n2-a"]);

    // Moving Nursery 2 up moves ONE: the pupil who was actually enrolled there.
    expect(moveClassUp("Nursery 2")).toBe(1);

    expect(pupils.find((p) => p.id === "n1-a")!.class).toBe("Nursery 2");
    expect(pupils.find((p) => p.id === "n1-b")!.class).toBe("Nursery 2");
    expect(pupils.find((p) => p.id === "n2-a")!.class).toBe("Nursery 3");
    // Primary 1 is two rungs up from Nursery 1. Nobody reaching it is the
    // whole point: that is what a double promotion would look like.
    expect(pupils.some((p) => p.class === "Primary 1")).toBe(false);
  });

  it("gives each pupil exactly one enrolment in the new session", () => {
    const { enrolments, moveClassUp } = school();
    moveClassUp("Nursery 1");
    moveClassUp("Nursery 2");

    const next = enrolments.filter((e) => e.session_id === TO);
    expect(next).toHaveLength(3);
    expect(new Set(next.map((e) => e.student_id)).size).toBe(3);
  });

  it("reaches the same place whichever order the classes are moved in", () => {
    // Top-down is the order that hides the bug, so it must agree with
    // bottom-up. If it ever does not, the filter has started reading the
    // pupil's current class.
    const downwards = school();
    downwards.moveClassUp("Nursery 2");
    downwards.moveClassUp("Nursery 1");

    const upwards = school();
    upwards.moveClassUp("Nursery 1");
    upwards.moveClassUp("Nursery 2");

    const shape = (s: { pupils: Pupil[] }) =>
      s.pupils.map((p) => `${p.id}:${p.class}`).sort();
    expect(shape(downwards)).toEqual(shape(upwards));
  });

  it("moving the same class twice moves nobody the second time", () => {
    const { moveClassUp, pupils } = school();
    moveClassUp("Nursery 1");
    expect(moveClassUp("Nursery 1")).toBe(0);
    expect(pupils.find((p) => p.id === "n1-a")!.class).toBe("Nursery 2");
  });
});

describe("the Deno mirror stays in sync", () => {
  const stripHeader = (s: string) => s.replace(/^(\/\/.*\n|\s*\n)+/, "").trim();
  it("has identical logic to src/lib/rollover.ts", () => {
    const root = resolve(__dirname, "../..");
    const web = readFileSync(resolve(root, "src/lib/rollover.ts"), "utf8");
    const deno = readFileSync(resolve(root, "supabase/functions/_shared/rollover.ts"), "utf8");
    expect(stripHeader(deno)).toBe(stripHeader(web));
  });
});
