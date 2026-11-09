import { useEffect, useRef } from 'react';
import { useRoute } from './hooks.ts';
import { BenchPage } from './pages/Bench.tsx';
import { ExplorePage } from './pages/Explore.tsx';
import { Home } from './pages/Home.tsx';
import { ReviewPage } from './pages/Review.tsx';
import { RunPage } from './pages/Run.tsx';

// App shell: skip link, header, one <main> per route.

export function App() {
  const route = useRoute();
  const main = useRef<HTMLElement>(null);
  const key = route.page === 'run' || route.page === 'bench' || route.page === 'review' || route.page === 'explore' ? `${route.page}:${route.id}` : route.page;

  // On navigation (not on refresh): back to the top, focus moves to the page for screen readers.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    main.current?.focus();
  }, [key]);

  useEffect(() => {
    document.title =
      route.page === 'review'
        ? `Review ${route.id} · TwoPass`
        : route.page === 'explore'
          ? `Explore ${route.id} · TwoPass`
        : route.page === 'run' ? `${route.id} · TwoPass` : route.page === 'bench' ? `${route.id} · TwoPass` : 'TwoPass · runs';
  }, [route]);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <a href="#/" className="brand">
          <span aria-hidden="true" className="logo">
            ⇉
          </span>
          TwoPass
        </a>
        <span className="muted small">local run monitor and review queue</span>
      </header>
      <main id="main" ref={main} tabIndex={-1} key={key}>
        {route.page === 'home' && <Home />}
        {route.page === 'run' && <RunPage id={route.id} />}
        {route.page === 'review' && <ReviewPage id={route.id} />}
        {route.page === 'bench' && <BenchPage id={route.id} />}
        {route.page === 'explore' && <ExplorePage id={route.id} />}
        {route.page === 'notfound' && (
          <>
            <h1>Page not found</h1>
            <p>
              <a href="#/">Back to all runs</a>
            </p>
          </>
        )}
      </main>
    </>
  );
}
