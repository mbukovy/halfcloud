import { ref, watch } from 'vue';

export function useTheme() {
  let preferred: string | null = null;
  try {
    preferred = window.localStorage.getItem('halfcloud:theme');
  } catch {
    // Storage can be unavailable in restricted browsing contexts.
  }
  const theme = ref<'light' | 'dark'>(
    preferred === 'light' || preferred === 'dark'
      ? preferred
      : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );

  watch(theme, (value) => {
    document.documentElement.dataset.theme = value;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#151c19' : '#f2efe7');
  }, { immediate: true, flush: 'sync' });

  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    try {
      window.localStorage.setItem('halfcloud:theme', theme.value);
    } catch {
      // Keep the switch usable even when the preference cannot be saved.
    }
  }

  return { theme, toggleTheme };
}
