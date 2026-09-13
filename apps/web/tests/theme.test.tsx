import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ThemeProvider, useTheme } from '../src/ui/theme.js';

describe('Theme resolution and persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(query => ({
      matches: query === '(prefers-color-scheme: light)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const TestConsumer = () => {
    const { theme, resolvedTheme } = useTheme();
    return <div data-testid="theme-info">{`${theme}:${resolvedTheme}`}</div>;
  };

  it('no stored preference defaults to system', () => {
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    const html = renderToString(<ThemeProvider><TestConsumer /></ThemeProvider>);
    expect(html).toContain('system:dark'); // renderToString runs synchronously, window isn't fully mocked for useEffect
  });

  it('respects stored light preference', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('light');
    const html = renderToString(<ThemeProvider><TestConsumer /></ThemeProvider>);
    expect(html).toContain('light:dark'); // because resolvedTheme defaults to dark in useState before useEffect
  });

});
