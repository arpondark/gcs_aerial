---
name: Kinetic Command
colors:
  surface: '#101418'
  surface-dim: '#101418'
  surface-bright: '#36393f'
  surface-container-lowest: '#0a0f13'
  surface-container-low: '#3c587a'
  surface-container: '#1c2025'
  surface-container-high: '#262a2f'
  surface-container-highest: '#31353a'
  on-surface: '#e0e2e9'
  on-surface-variant: '#c6c6ca'
  inverse-surface: '#e0e2e9'
  inverse-on-surface: '#2d3136'
  outline: '#8f9094'
  outline-variant: '#45474a'
  surface-tint: '#c6c6ca'
  primary: '#c6c6ca'
  on-primary: '#2f3034'
  primary-container: '#121417'
  on-primary-container: '#7d7e82'
  inverse-primary: '#5d5e62'
  secondary: '#ffb77d'
  on-secondary: '#4d2600'
  secondary-container: '#fd8b00'
  on-secondary-container: '#603100'
  tertiary: '#00daf3'
  on-tertiary: '#00363d'
  tertiary-container: '#00171b'
  on-tertiary-container: '#008b9c'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e2e2e6'
  primary-fixed-dim: '#c6c6ca'
  on-primary-fixed: '#1a1c1f'
  on-primary-fixed-variant: '#45474a'
  secondary-fixed: '#ffdcc3'
  secondary-fixed-dim: '#ffb77d'
  on-secondary-fixed: '#2f1500'
  on-secondary-fixed-variant: '#6e3900'
  tertiary-fixed: '#9cf0ff'
  tertiary-fixed-dim: '#00daf3'
  on-tertiary-fixed: '#001f24'
  on-tertiary-fixed-variant: '#004f58'
  background: '#101418'
  on-background: '#e0e2e9'
  surface-variant: '#31353a'
typography:
  display:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: 0em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0em
  mono-lg:
    fontFamily: JetBrains Mono
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
    letterSpacing: 0em
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0em
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.08em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 12px
  panel-padding: 16px
---

## Brand & Style
This design system is engineered for mission-critical robotics operations. The brand personality is **precise, industrial, and hyper-reliable**, prioritizing data density and cognitive clarity over decorative aesthetics. 

The design style is **Technical Modernism**. It utilizes a dark-mode-first approach to reduce eye strain during long monitoring sessions and to allow vibrant telemetry accents to pop. The UI takes inspiration from aeronautics and industrial control panels: high-density layouts, clear structural hierarchies, and a "function-over-form" philosophy that ensures every pixel serves a purpose. It balances the utility of professional enterprise software with the cutting-edge feel of a modern aerospace interface.

## Colors
The palette is rooted in a "Deep Space" hierarchy to maximize contrast for active elements. 

- **Basics:** The background is near-black to minimize light emission, while containers use `#121417` and `#1E2227` to create structural depth.
- **Accents:** 
    - **Safety Orange (#FF8C00):** Used exclusively for high-priority actions, manual overrides, and critical hardware states.
    - **Telemetry Cyan (#00E5FF):** Used for data streams, active sensors, and non-critical system feedback.
    - **Success Green (#00C853):** Reserved for "Ready" states, successful transmissions, and nominal battery levels.
- **Contrast:** High-contrast borders in `#2D333B` define the edges of high-density panels, ensuring components don't bleed into each other in low-light environments.

## Typography
The system uses a dual-font strategy to separate UI navigation from live data streams.

- **Inter (SaaS/UI):** Handles all structural elements, buttons, and settings. It is chosen for its exceptional legibility and neutral character.
- **JetBrains Mono (Telemetry/Values):** Used for all numerical data, coordinates, and system logs. The monospaced nature ensures that flickering data values (like GPS or Velocity) remain visually stable and don't cause layout shifts.
- **Hierarchy:** All labels for data points should use the `label-caps` style in a muted gray to emphasize the variable value itself.

## Layout & Spacing
The layout follows a **High-Density Fixed Grid** system optimized for 1920x1080 and 4K displays.

- **Panel Model:** Content is housed in modular "Widget Containers." These panels use a strict 4px baseline grid.
- **Gaps:** Gutters are kept tight (12px) to maximize the "Command Center" feel and allow for more simultaneous data streams.
- **Reflow:** On desktop, the layout utilizes a sidebar-heavy architecture for system health, with a central flexible area for primary feeds (LIDAR, Camera, or Map). 
- **Density:** Padding inside components like lists and cards should be "Compact" (8px to 12px) to ensure no scrolling is required for essential metrics.

## Elevation & Depth
This design system avoids soft shadows in favor of **Tonal Layering and Sharp Outlines**. 

- **Surface Levels:** 
    - Level 0 (Base): Background (`#0B0C0E`).
    - Level 1 (Panels): Container (`#121417`) with a 1px solid border (`#2D333B`).
    - Level 2 (Popovers/Modals): Elevated (`#1E2227`) with a subtle Cyan-tinted glow or a stronger 2px border to denote focus.
- **Interactions:** Buttons do not use shadows to show "press." Instead, they use color fills or inner strokes. This maintains the "flat-panel" industrial look of physical hardware.

## Shapes
The shape language is **Industrial-Soft**. 

- **Corners:** A base radius of 4px (`rounded-sm`) is applied to all cards and buttons. This provides just enough softness to distinguish digital elements from raw code while maintaining a rigid, architectural feel.
- **Progress Bars & Status:** Small components like status pills use a 2px radius or sharp edges to look like hardware LEDs.
- **Interactive Elements:** Checkboxes and inputs use a strict 2px radius for a technical, precise appearance.

## Components
- **Buttons:** Primary buttons use solid Safety Orange or Telemetry Cyan. Secondary buttons use a "Ghost" style with a 1px border. No gradients.
- **High-Density Cards:** Cards should have a header area with a `label-caps` title and an optional status dot. Data points inside are arranged in a 2-column grid with labels on top of values.
- **Status Pills:** Small, rectangular indicators. "Active" states should use a subtle outer glow (0-0-8px) in the respective state color (Green, Cyan, or Orange).
- **Custom Gauges:** Circular or horizontal "Thermometer" style gauges. Use a background track of `#2D333B` and a colored fill for the value. 
- **Telemetry Lists:** Use monospaced font, no row dividers. Instead, use alternating row tints (zebra striping) at very low opacity (3%) for readability.
- **Input Fields:** Dark background (`#0B0C0E`), 1px border. On focus, the border changes to Cyan.