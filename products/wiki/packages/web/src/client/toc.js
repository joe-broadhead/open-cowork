function initTocScrollSpy() {
  document.querySelectorAll(".ow-toc").forEach((toc) => {
    const links = Array.from(toc.querySelectorAll('a[href^="#"]'));
    const headings = links
      .map((link) => ({ link, heading: document.getElementById(decodeURIComponent(link.getAttribute("href").slice(1))) }))
      .filter((entry) => entry.heading);
    if (headings.length === 0) return;
    const setActive = (id) => {
      links.forEach((link) => {
        const active = link.getAttribute("href") === "#" + id;
        link.classList.toggle("is-active", active);
        if (active) {
          link.setAttribute("aria-current", "true");
        } else {
          link.removeAttribute("aria-current");
        }
      });
    };
    if (!("IntersectionObserver" in window)) {
      setActive(headings[0].heading.id);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      if (visible?.target?.id) setActive(visible.target.id);
    }, { rootMargin: "-20% 0px -65% 0px", threshold: [0, 1] });
    headings.forEach((entry) => observer.observe(entry.heading));
  });
}

export { initTocScrollSpy };
