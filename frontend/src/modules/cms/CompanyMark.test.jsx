import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CompanyMark } from './CompanyMark.jsx';

afterEach(cleanup);

test('a real logo renders as a bare image with the logo class, never inside the styled fallback tile', () => {
  const { container } = render(<CompanyMark logoUrl="blob:logo" logoClassName="logo" fallbackClassName="tile" />);
  const img = container.querySelector('img');
  expect(img.getAttribute('src')).toBe('blob:logo');
  expect(img.className).toBe('logo');
  expect(container.querySelector('.tile')).toBeNull();
  expect(container.textContent).toBe('');
});

test('no logo keeps the styled ES fallback mark', () => {
  const { container } = render(<CompanyMark logoUrl={null} logoClassName="logo" fallbackClassName="tile" />);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('.tile').textContent).toBe('ES');
});

test('a logo that fails to decode falls back to ES; a new logo URL is tried again', () => {
  const { container, rerender } = render(<CompanyMark logoUrl="blob:broken" logoClassName="logo" fallbackClassName="tile" />);
  fireEvent.error(container.querySelector('img'));
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('.tile').textContent).toBe('ES');
  rerender(<CompanyMark logoUrl="blob:fixed" logoClassName="logo" fallbackClassName="tile" />);
  expect(container.querySelector('img').getAttribute('src')).toBe('blob:fixed');
});

test('fallback={null} renders nothing when there is no usable logo', () => {
  const { container } = render(<CompanyMark logoUrl={null} fallback={null} />);
  expect(container.innerHTML).toBe('');
});
