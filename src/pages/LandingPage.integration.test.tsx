import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LandingPage from "./LandingPage";

// jsdom doesn't implement scrollIntoView; the nav anchors call it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>
  );

describe("LandingPage (integration)", () => {
  it("renders the brand wordmark and the free-for-schools promise", () => {
    renderPage();
    // "EduLedger" + "NG" are split across spans; check both appear.
    expect(screen.getAllByText(/EduLedger/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Free for schools\. Always\./i)).toBeInTheDocument();
  });

  it("shows the hero headline and the primary CTA", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: /Secure Payments/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Get Started for Free/i }).length).toBeGreaterThan(0);
  });

  it("has every nav section: About, Features, Solutions, Pricing, Contact", () => {
    const { container } = renderPage();
    for (const id of ["about", "features", "solutions", "pricing", "contact"]) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("shows the real contact details", () => {
    renderPage();
    const email = screen.getByRole("link", { name: /eduledgerng@gmail\.com/i });
    expect(email).toHaveAttribute("href", "mailto:eduledgerng@gmail.com");
    const wa = screen.getByRole("link", { name: /\+234 913 358 6788/ });
    expect(wa).toHaveAttribute("href", expect.stringContaining("wa.me/2349133586788"));
  });

  it("states the pricing model (school pays nothing)", () => {
    const { container } = renderPage();
    const pricing = container.querySelector("#pricing") as HTMLElement;
    expect(within(pricing).getAllByText(/your school pays nothing/i).length).toBeGreaterThan(0);
    expect(within(pricing).getAllByText(/No setup fee/i).length).toBeGreaterThan(0);
  });

  it("contains NO em dashes (guards the 'reads as AI' regression)", () => {
    const { container } = renderPage();
    expect(container.textContent || "").not.toContain("—");
  });
});
