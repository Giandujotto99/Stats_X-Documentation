# Tutorial v1.4 Sections

Add your Blueprints tutorial section files in this folder.

## How to add a new section

1. Create a new HTML file in this folder, for example `02_Installation.html`.
2. Register it in `manifest.json` with `id`, `label`, and `file`.
3. Open `tutorials-v1.4-blueprints.html#your-section-id` or click it from the sidebar.

## Supported file formats

- Full section markup:

```html
<section id="installation" class="tutorial-section">
    <h1>Installation</h1>
    <p>...</p>
</section>
```

- Raw body content only:

```html
<h1>Installation</h1>
<p>...</p>
```

If the loader does not find `.tutorial-section`, it wraps the file automatically.
