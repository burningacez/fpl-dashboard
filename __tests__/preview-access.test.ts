import { describe, it, expect, afterEach } from 'vitest';
import { allowlistAdmits, previewAllowed } from '../src/server/preview-access';
import config from '../src/server/config';

// config.server.NODE_ENV is read at module load; the object is frozen at the
// top level but the nested groups are not, so the env can be swapped per test.
const originalEnv = config.server.NODE_ENV;
function withNodeEnv(env: string) {
  config.server.NODE_ENV = env;
}
afterEach(() => {
  config.server.NODE_ENV = originalEnv;
});

describe('allowlistAdmits', () => {
  it('admits only listed entries', () => {
    expect(allowlistAdmits([11, 22], 22)).toBe(true);
    expect(allowlistAdmits([11, 22], 33)).toBe(false);
  });

  it('is closed in production when the allowlist is unset', () => {
    withNodeEnv('production');
    expect(allowlistAdmits([], 33)).toBe(false);
  });

  it('is open in development when the allowlist is unset, so local testing needs no setup', () => {
    withNodeEnv('development');
    expect(allowlistAdmits([], 33)).toBe(true);
  });
});

describe('previewAllowed', () => {
  it('lets every logged-in entry into a released feature, allowlist or not', () => {
    // The squad builder is released: an allowlist left over from its preview
    // must not keep anyone out.
    withNodeEnv('production');
    expect(previewAllowed('planner-squad-builder', 33, [11, 22])).toBe(true);
    expect(previewAllowed('planner-squad-builder', 33, [])).toBe(true);
  });

  describe('guided-walkthroughs (released)', () => {
    it('admits everyone in production, allowlist or not', () => {
      withNodeEnv('production');
      expect(previewAllowed('guided-walkthroughs', 22, [11, 22])).toBe(true);
      expect(previewAllowed('guided-walkthroughs', 33, [11, 22])).toBe(true);
      expect(previewAllowed('guided-walkthroughs', 22, [])).toBe(true);
    });

    it('admits an unclaimed device, whose entry id is 0', () => {
      // /api/identity/me passes 0 when no team is claimed, and the walkthrough's
      // whole audience is people who haven't got their bearings yet.
      withNodeEnv('production');
      expect(previewAllowed('guided-walkthroughs', 0, [11, 22])).toBe(true);
      expect(previewAllowed('guided-walkthroughs', 0, [])).toBe(true);
    });
  });
});
