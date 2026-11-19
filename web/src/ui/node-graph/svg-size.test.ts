import { describe, expect, it } from 'vitest';
import { svgSize } from './svg-size';

describe('svgSize: the picture size the fullscreen canvas fits (issue #17)', () => {
  it("Mermaid's output: width 100%, the size in the viewBox (its origin may be negative)", () => {
    const svg = '<svg id="mmd-3" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 523.5px;" viewBox="-8 -8 523.5 300" role="graphics-document document"><g/></svg>';
    expect(svgSize(svg)).toEqual({ w: 523.5, h: 300 });
  });
  it('a viewBox with commas or single quotes', () => {
    expect(svgSize('<svg viewBox="0,0,100,50"></svg>')).toEqual({ w: 100, h: 50 });
    expect(svgSize("<svg viewBox='0 0 10 20'></svg>")).toEqual({ w: 10, h: 20 });
  });
  it('no viewBox: width and height in px (or unitless)', () => {
    expect(svgSize('<svg width="640" height="480px"></svg>')).toEqual({ w: 640, h: 480 });
  });
  it('a stroke-width or a max-width style is not the width', () => {
    expect(svgSize('<svg stroke-width="2" style="max-width: 300px" height="40"></svg>')).toBeNull();
  });
  it('nothing usable: a percentage, an empty or broken viewBox, no <svg> at all', () => {
    expect(svgSize('<svg width="100%" height="100%"></svg>')).toBeNull();
    expect(svgSize('<svg viewBox="0 0 0 0" width="20" height="10"></svg>')).toEqual({ w: 20, h: 10 });
    expect(svgSize('<svg viewBox="0 0 a b"></svg>')).toBeNull();
    expect(svgSize('mermaid: Parse error')).toBeNull();
  });
});
