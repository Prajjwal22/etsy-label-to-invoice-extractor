import { Download, FileUp, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const EU_IOSS_COUNTRIES = new Set([
  "austria", "belgium", "bulgaria", "croatia", "cyprus", "czech republic",
  "czechia", "denmark", "estonia", "finland", "france", "germany", "greece",
  "hungary", "ireland", "italy", "latvia", "lithuania", "luxembourg", "malta",
  "netherlands", "poland", "portugal", "romania", "slovakia", "slovenia",
  "spain", "sweden"
]);

const emptyOrder = {
  invoiceNo: "",
  invoiceDate: "",
  orderNumber: "",
  customerName: "",
  address: "",
  country: "",
  productTitle: "",
  sku: "",
  quantity: 1,
  unitPrice: 0,
  subtotalExTax: 0,
  etsyOrderValue: 0,
  invoiceValue: 0,
  currency: "USD",
  taxOverride: "auto",
  confidence: 0
};


const currencySymbols = {
  USD: "$",
  EUR: "\u20ac",
  GBP: "\u00a3",
  AUD: "A$",
  CAD: "C$",
  INR: "\u20b9"
};

function App() {
  const [order, setOrder] = useState(emptyOrder);
  const [status, setStatus] = useState("Upload an Etsy PDF label or packing slip to extract invoice details.");
  const [debugBlocks, setDebugBlocks] = useState([]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [latestImageUrl, setLatestImageUrl] = useState("");

  const taxMode = useMemo(() => getTaxMode(order), [order.country, order.taxOverride]);
  const invoiceValue = Number(order.invoiceValue || (taxMode === "none" ? order.subtotalExTax : order.etsyOrderValue) || 0);

  function updateField(name, value) {
    setOrder((current) => ({ ...current, [name]: value }));
  }

  async function buildTemplatePdf() {
    const response = await fetch("/api/generate-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...order, invoiceValue })
    });
    if (!response.ok) throw new Error(await response.text());
    return response.blob();
  }

  async function buildPreviewUrls() {
    const response = await fetch("/api/preview-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...order, invoiceValue })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    return payload;
  }

  useEffect(() => {
    const hasInvoiceData = order.customerName || order.orderNumber || order.productTitle;
    if (!hasInvoiceData) {
      setPreviewUrl("");
      setLatestImageUrl("");
      return undefined;
    }

    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const urls = await buildPreviewUrls();
        if (!active) return;
        setPreviewUrl(urls.imageUrl);
        setLatestImageUrl(urls.imageUrl);
      } catch {
        if (active) {
          setPreviewUrl("");
          setLatestImageUrl("");
        }
      }
    }, 450);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [order, invoiceValue]);

  async function uploadPdf(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    setStatus("Reading Etsy PDF with Python parser...");
    try {
      const response = await fetch("/api/parse-pdf", { method: "POST", body: form });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setOrder({ ...emptyOrder, ...payload.order });
      setDebugBlocks(payload.debug?.blocks || []);
      setStatus(`Imported ${file.name}. Confidence: ${payload.order.confidence || 0}%. Review, then download.`);
    } catch (error) {
      setStatus(`Could not parse PDF: ${error.message}`);
    }
  }

  async function downloadTemplateInvoice() {
    setStatus("Generating invoice on the Canva PDF template...");
    try {
      const blob = await buildTemplatePdf();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `invoice-${order.orderNumber || order.invoiceNo || "etsy"}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus("Generated invoice PDF from the Canva template.");
    } catch (error) {
      setStatus(`Could not generate invoice: ${error.message}`);
    }
  }

  async function downloadTemplateImage() {
    setStatus("Generating invoice image...");
    try {
      let imageUrl = latestImageUrl;
      if (!imageUrl) {
        const urls = await buildPreviewUrls();
        imageUrl = urls.imageUrl;
        setPreviewUrl(urls.imageUrl);
        setLatestImageUrl(urls.imageUrl);
      }
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `invoice-${order.orderNumber || order.invoiceNo || "etsy"}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus("Downloaded invoice image.");
    } catch (error) {
      setStatus(`Could not download image: ${error.message}`);
    }
  }

  function reset() {
    setOrder(emptyOrder);
    setDebugBlocks([]);
    setPreviewUrl("");
    setLatestImageUrl("");
    setStatus("Upload an Etsy PDF label or packing slip to extract invoice details.");
  }

  return (
    <main className="app-shell">
      <section className="workspace" aria-label="Invoice controls">
        <div className="topbar">
          <div>
            <h1>Owleaf Etsy Invoice Generator</h1>
            <p>Upload an Etsy PDF, review extracted fields, then download the invoice.</p>
          </div>
          <button className="primary-action" type="button" onClick={downloadTemplateInvoice}>
            <Download size={18} /> Download PDF
          </button>
          <button type="button" onClick={downloadTemplateImage}>
            <Download size={18} /> Download Image
          </button>
        </div>

        <section className="panel">
          <div className="panel-title">
            <h2>Import Etsy PDF</h2>
            <button type="button" onClick={reset}><RotateCcw size={16} /> Reset</button>
          </div>
          <label className="upload-zone">
            <FileUp size={28} />
            <span>Choose Etsy PDF label / packing slip</span>
            <input type="file" accept="application/pdf,.pdf" onChange={uploadPdf} />
          </label>
          <p className="import-status">{status}</p>
          <div className="button-row">
            <button className="primary-action" type="button" onClick={downloadTemplateInvoice}>
              <Download size={17} /> Download Canva Template PDF
            </button>
            <button type="button" onClick={downloadTemplateImage}>
              <Download size={17} /> Download Image
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Order</h2>
            <span className="logic-pill">{taxMode === "ioss" ? "EU IOSS" : taxMode === "ukvat" ? "UK VAT" : "Non VAT"}</span>
          </div>
          <div className="form-grid">
            <Field label="Invoice No." value={order.invoiceNo} onChange={(value) => updateField("invoiceNo", value)} />
            <Field label="Invoice Date" type="date" value={order.invoiceDate} onChange={(value) => updateField("invoiceDate", value)} />
            <Field label="Order #" value={order.orderNumber} onChange={(value) => updateField("orderNumber", value)} />
            <label>Currency
              <select value={order.currency} onChange={(event) => updateField("currency", event.target.value)}>
                {["USD", "EUR", "GBP", "AUD", "CAD", "INR"].map((item) => <option key={item} value={item}>{item} {currencySymbols[item]}</option>)}
              </select>
            </label>
            <Field label="Quantity" type="number" value={order.quantity} onChange={(value) => updateField("quantity", value)} />
            <Field label="Invoice Value" type="number" value={invoiceValue} onChange={(value) => updateField("invoiceValue", value)} />
            <Field label="Subtotal Excluding Tax" type="number" value={order.subtotalExTax} onChange={(value) => updateField("subtotalExTax", value)} />
            <Field label="Etsy Order Total" type="number" value={order.etsyOrderValue} onChange={(value) => updateField("etsyOrderValue", value)} />
          </div>
        </section>

        <section className="panel">
          <h2>Customer & Item</h2>
          <div className="form-grid wide-grid">
            <Field label="Customer Name" value={order.customerName} onChange={(value) => updateField("customerName", value)} />
            <Field label="Country" value={order.country} onChange={(value) => updateField("country", value)} />
            <label className="full">Address
              <textarea rows="4" value={order.address} onChange={(event) => updateField("address", event.target.value)} />
            </label>
            <Field className="full" label="Product Title" value={order.productTitle} onChange={(value) => updateField("productTitle", value)} />
            <Field label="SKU" value={order.sku} onChange={(value) => updateField("sku", value)} />
            <label>VAT / IOSS Override
              <select value={order.taxOverride} onChange={(event) => updateField("taxOverride", event.target.value)}>
                <option value="auto">Auto by country</option>
                <option value="none">No VAT/IOSS</option>
                <option value="ioss">Etsy IOSS</option>
                <option value="ukvat">Etsy UK VAT</option>
              </select>
            </label>
          </div>
        </section>

        {debugBlocks.length > 0 && (
          <section className="panel debug-panel">
            <h2>Parser Blocks</h2>
            <pre>{debugBlocks.slice(0, 18).map((block) => `p${block.page} (${Math.round(block.x0)},${Math.round(block.y0)}) ${block.text}`).join("\n\n")}</pre>
          </section>
        )}
      </section>

      <TemplatePdfPreview previewUrl={previewUrl} />
    </main>
  );
}

function Field({ label, value, onChange, type = "text", className = "" }) {
  return (
    <label className={className}>{label}
      <input type={type} step={type === "number" ? "0.01" : undefined} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TemplatePdfPreview({ previewUrl }) {
  return (
    <section className="preview-wrap" aria-label="Generated invoice preview">
      {previewUrl ? (
        <img className="pdf-preview-clean" alt="Generated Canva-template invoice preview" src={previewUrl} />
      ) : (
        <div className="empty-preview">
          <h2>Template PDF Preview</h2>
          <p>Upload an Etsy PDF to generate a preview from the Canva template.</p>
        </div>
      )}
    </section>
  );
}

function getTaxMode(order) {
  if (order.taxOverride !== "auto") return order.taxOverride;
  const country = String(order.country || "").trim().toLowerCase();
  if (["united kingdom", "uk", "great britain"].includes(country)) return "ukvat";
  if (EU_IOSS_COUNTRIES.has(country)) return "ioss";
  return "none";
}

createRoot(document.getElementById("root")).render(<App />);
