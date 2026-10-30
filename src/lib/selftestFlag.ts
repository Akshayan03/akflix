/**
 * Set while the hidden playback self-test runs (see selftest.ts): its test
 * titles must not land in watch history, recommendations or account sync.
 */
let active = false;

export const selftestActive = (): boolean => active;

export function setSelftestActive(value: boolean): void {
  active = value;
}
