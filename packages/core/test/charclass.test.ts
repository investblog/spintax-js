import { describe, test, expect } from 'vitest';
import { isUcpSpace, UCP_SPACE } from '../src/internal/charclass';

describe('charclass', () => {
  // The capitalization scanner reads char codes where the regexes read the class; the two must be one set.
  test('isUcpSpace is exactly the UCP_SPACE class, over the whole BMP', () => {
    const re = new RegExp(`^[${UCP_SPACE}]$`, 'u');
    const mismatches: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (isUcpSpace(code) !== re.test(String.fromCharCode(code))) mismatches.push(code.toString(16));
    }
    expect(mismatches).toEqual([]);
  });
});
