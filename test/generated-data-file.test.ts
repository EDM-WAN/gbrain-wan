import { describe, expect, test } from 'bun:test';
import { classifyGeneratedDataFile, GENERATED_AVG_LINE_CHARS } from '../src/core/generated-data-file.ts';

/**
 * An LVGL-style image array: one declaration, hundreds of hex rows.
 * Row width matters — real generated blobs pack a full scanline per line
 * (measured: img_star.c averages 437 chars/line, bsp_rgb_shift.h 232), which
 * is exactly the signal this rule keys on.
 */
function imageArray(rows = 400): string {
  const hex = (n: number) => Array.from({ length: n }, () => '0x00').join(', ');
  const body = Array.from({ length: rows }, () => '    ' + hex(40)).join(',\n');
  return `#include "lvgl.h"\n\nconst uint8_t img_map[] = {\n${body}\n};\n`;
}

/** Real C: short lines, definitions present. */
const SOURCE = `
#include <stdint.h>
#include "shell_cmd.h"

/* Look up a command by name and dispatch it. */
static int shell_dispatch(const char *name, int argc, char **argv)
{
    for (int i = 0; i < cmd_count; i++) {
        if (strcmp(name, commands[i].cmd) == 0) {
            return commands[i].func(argc, argv);
        }
    }
    return -1;
}

int shell_get_argc(const char *line)
{
    return count_tokens(line);
}
`.repeat(6);

describe('generated data blob detection', () => {
  test('LVGL image array is classified as generated', () => {
    const v = classifyGeneratedDataFile(imageArray(), '.c');
    expect(v.generated).toBe(true);
    expect(v.avgLineChars).toBeGreaterThan(GENERATED_AVG_LINE_CHARS);
    expect(v.definitions).toBe(0);
  });

  test('ordinary C source is not', () => {
    const v = classifyGeneratedDataFile(SOURCE, '.c');
    expect(v.generated).toBe(false);
  });

  test('a long-line source WITH definitions is kept', () => {
    // Mixed file (arm_common_tables.c shape): dense tables but real accessors.
    const mixed = imageArray(200) + `
float *arm_get_twiddle(int n)
{
    return twiddle[n];
}
`;
    const v = classifyGeneratedDataFile(mixed, '.c');
    expect(v.definitions).toBeGreaterThanOrEqual(1);
    // One definition is still under the bound — the rule tolerates a couple.
    expect(v.generated).toBe(true);
  });

  test('single-line array (audio header shape) is caught', () => {
    // component/audio/*/*.h pack the ENTIRE array onto one line: the line-based
    // signal sees one 262 144-char line, so only literal density can catch it.
    const oneLine = `const unsigned char rec[] = {${Array.from({ length: 3000 }, (_, i) => i % 256).join(', ')}};\n`;
    const v = classifyGeneratedDataFile(oneLine, '.h');
    expect(v.generated).toBe(true);
    expect(v.dataLiteralRatio).toBeGreaterThan(0.6);
  });

  test('12-per-line JPEG byte table (jpeg_data.c shape) is caught', () => {
    // Short lines defeat any average-length threshold; density still works.
    const rows = Array.from({ length: 400 }, () =>
      '\t' + Array.from({ length: 12 }, () => '0xff').join(', ') + ',').join('\n');
    const v = classifyGeneratedDataFile(`const unsigned char jpeg_data[] = {\n${rows}\n};\n`, '.c');
    expect(v.generated).toBe(true);
  });

  test('ordinary code with some numbers is NOT caught', () => {
    const numeric = `
static const uint32_t baud_table[] = { 115200, 921600, 1500000 };
static const uint8_t pin_list[] = { 1, 2, 3, 4 };

void UART_Init(uint32_t baud)
{
    for (int i = 0; i < 3; i++) {
        if (baud_table[i] == baud) {
            REG_WRITE(UART_DLL, i);
            break;
        }
    }
}
`;
    expect(classifyGeneratedDataFile(numeric.repeat(4), '.c').generated).toBe(false);
  });

  test('non-C languages are never dropped by this rule', () => {
    expect(classifyGeneratedDataFile(imageArray(), '.js').generated).toBe(false);
    expect(classifyGeneratedDataFile(imageArray(), '.py').generated).toBe(false);
  });

  test('empty and whitespace-only input are not generated', () => {
    expect(classifyGeneratedDataFile('', '.c').generated).toBe(false);
    expect(classifyGeneratedDataFile('\n\n  \n', '.c').generated).toBe(false);
  });
});
