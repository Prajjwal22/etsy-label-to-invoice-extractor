import { Download, FileCheck2, FileUp, Heart, Leaf, RotateCcw, ShieldCheck } from "lucide-react";
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

const inputClass = "min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 outline-none transition focus:border-owleaf focus:ring-4 focus:ring-owleaf/10";
const labelClass = "grid gap-1.5 text-xs font-semibold text-slate-700";
const cardClass = "rounded-xl border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/60 backdrop-blur";
const buttonBase = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-wait disabled:opacity-70 sm:text-sm";
const primaryButton = `${buttonBase} border-owleaf bg-owleaf text-white shadow-sm shadow-owleaf/20 hover:bg-owleaf-dark`;
const secondaryButton = `${buttonBase} border-slate-200 bg-white text-slate-900 hover:border-owleaf/50 hover:bg-owleaf-soft`;

function App() {
  const [order, setOrder] = useState(emptyOrder);
  const [status, setStatus] = useState("Upload an Etsy PDF label or packing slip to extract invoice details.");
  const [debugBlocks, setDebugBlocks] = useState([]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [latestImageUrl, setLatestImageUrl] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState({
    upload: false,
    preview: false,
    pdf: false,
    image: false
  });

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
    return response.json();
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
        setLoading((current) => ({ ...current, preview: true }));
        const urls = await buildPreviewUrls();
        if (!active) return;
        setPreviewUrl(urls.imageUrl);
        setLatestImageUrl(urls.imageUrl);
      } catch {
        if (active) {
          setPreviewUrl("");
          setLatestImageUrl("");
        }
      } finally {
        if (active) setLoading((current) => ({ ...current, preview: false }));
      }
    }, 450);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [order, invoiceValue]);

  async function handlePdfFile(file) {
    if (!file) return;
    if (file.type && file.type !== "application/pdf") {
      setStatus("Please upload a PDF file.");
      return;
    }
    setSelectedFileName(file.name);
    const form = new FormData();
    form.append("file", file);
    setStatus("Reading Etsy PDF with Python parser...");
    setLoading((current) => ({ ...current, upload: true }));
    try {
      const response = await fetch("/api/parse-pdf", { method: "POST", body: form });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setOrder({ ...emptyOrder, ...payload.order });
      setDebugBlocks(payload.debug?.blocks || []);
      setStatus(`Imported successfully. Confidence: ${payload.order.confidence || 0}%. Review, then download.`);
    } catch (error) {
      setStatus(`Could not parse PDF: ${error.message}`);
    } finally {
      setLoading((current) => ({ ...current, upload: false }));
    }
  }

  async function uploadPdf(event) {
    await handlePdfFile(event.target.files?.[0]);
    event.target.value = "";
  }

  async function dropPdf(event) {
    event.preventDefault();
    setIsDragging(false);
    await handlePdfFile(event.dataTransfer.files?.[0]);
  }

  async function downloadTemplateInvoice() {
    setStatus("Generating invoice on the Canva PDF template...");
    setLoading((current) => ({ ...current, pdf: true }));
    try {
      const blob = await buildTemplatePdf();
      downloadBlob(blob, `${invoiceFileName(order)}.pdf`);
      setStatus("Generated invoice PDF from the Canva template.");
    } catch (error) {
      setStatus(`Could not generate invoice: ${error.message}`);
    } finally {
      setLoading((current) => ({ ...current, pdf: false }));
    }
  }

  async function downloadTemplateImage() {
    setStatus("Generating invoice image...");
    setLoading((current) => ({ ...current, image: true }));
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
      downloadBlob(blob, `${invoiceFileName(order)}.png`);
      setStatus("Downloaded invoice image.");
    } catch (error) {
      setStatus(`Could not download image: ${error.message}`);
    } finally {
      setLoading((current) => ({ ...current, image: false }));
    }
  }

  function reset() {
    setOrder(emptyOrder);
    setDebugBlocks([]);
    setPreviewUrl("");
    setLatestImageUrl("");
    setSelectedFileName("");
    setStatus("Upload an Etsy PDF label or packing slip to extract invoice details.");
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto grid w-full max-w-[1500px] gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(390px,610px)_minmax(0,1fr)] lg:px-8 lg:py-8">
        <section className="min-w-0 space-y-4">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
                <div className="mb-5 flex items-center gap-3 text-owleaf">
                  <span className="grid size-9 place-items-center rounded-lg bg-owleaf text-white">
                    <Leaf size={20} />
                  </span>
                  <span className="text-2xl font-extrabold tracking-tight">Owleaf</span>
                </div>
              <h1 className="text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">Etsy Invoice Generator</h1>
              <p className="mt-3 max-w-md text-sm leading-6 text-slate-600 sm:text-base">
                Upload an Etsy PDF, review extracted fields, then download the invoice.
              </p>
            </div>
            <div className="grid gap-2 sm:flex sm:pt-14">
              <button className={primaryButton} type="button" onClick={downloadTemplateInvoice} disabled={loading.pdf || loading.upload}>
                {loading.pdf ? <Spinner /> : <Download size={15} />} {loading.pdf ? "Preparing PDF" : " PDF"}
              </button>
              <button className={secondaryButton} type="button" onClick={downloadTemplateImage} disabled={loading.image || loading.upload}>
                {loading.image ? <Spinner /> : <Download size={15} />} {loading.image ? "Preparing Image" : " Image"}
              </button>
            </div>
          </header>

          <Panel title="Import Etsy PDF" action={<button className={secondaryButton} type="button" onClick={reset}><RotateCcw size={16} /> Reset</button>}>
            <label
              className={`grid min-h-28 cursor-pointer place-items-center rounded-xl border border-dashed px-4 py-5 text-center text-sm font-bold transition ${
                isDragging
                  ? "border-owleaf bg-owleaf-soft text-owleaf-dark ring-4 ring-owleaf/10"
                  : "border-owleaf/30 bg-white text-owleaf hover:bg-owleaf-soft"
              }`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setIsDragging(false);
              }}
              onDrop={dropPdf}
            >
              <FileUp size={30} />
              <span className="mt-2">{loading.upload ? "Reading Etsy PDF..." : isDragging ? "Drop PDF here" : "Choose or drag Etsy PDF label / packing slip"}</span>
              <input className="hidden" type="file" accept="application/pdf,.pdf" onChange={uploadPdf} disabled={loading.upload} />
            </label>

            {selectedFileName && (
              <div className="mt-3 flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-owleaf text-white">
                  <FileCheck2 size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-slate-950">{selectedFileName}</p>
                  <p className="text-xs text-emerald-700">{status}</p>
                </div>
                <ShieldCheck className="shrink-0 text-emerald-600" size={20} />
              </div>
            )}

            {!selectedFileName && <p className="mt-3 text-sm leading-6 text-slate-600">{status}</p>}

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button className={primaryButton} type="button" onClick={downloadTemplateInvoice} disabled={loading.pdf || loading.upload}>
                {loading.pdf ? <Spinner /> : <Download size={15} />} {loading.pdf ? "Preparing PDF" : "Download Canva Template PDF"}
              </button>
              <button className={secondaryButton} type="button" onClick={downloadTemplateImage} disabled={loading.image || loading.upload}>
                {loading.image ? <Spinner /> : <Download size={15} />} {loading.image ? "Preparing Image" : "Download Image"}
              </button>
            </div>
          </Panel>

          <Panel title="Order Details" action={<span className="rounded-full border border-owleaf/30 bg-white px-3 py-1 text-xs font-bold text-owleaf">{taxMode === "ioss" ? "EU IOSS" : taxMode === "ukvat" ? "UK VAT" : "Non VAT"}</span>}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Invoice No." value={order.invoiceNo} onChange={(value) => updateField("invoiceNo", value)} />
              <Field label="Invoice Date" type="date" value={order.invoiceDate} onChange={(value) => updateField("invoiceDate", value)} />
              <Field label="Order #" value={order.orderNumber} onChange={(value) => updateField("orderNumber", value)} />
              <label className={labelClass}>Currency
                <select className={inputClass} value={order.currency} onChange={(event) => updateField("currency", event.target.value)}>
                  {["USD", "EUR", "GBP", "AUD", "CAD", "INR"].map((item) => <option key={item} value={item}>{item} {currencySymbols[item]}</option>)}
                </select>
              </label>
              <Field label="Quantity" type="number" value={order.quantity} onChange={(value) => updateField("quantity", value)} />
              <Field label="Invoice Value" type="number" value={invoiceValue} onChange={(value) => updateField("invoiceValue", value)} />
              <Field label="Subtotal (Excluding Tax)" type="number" value={order.subtotalExTax} onChange={(value) => updateField("subtotalExTax", value)} />
              <Field label="Order Total (Etsy)" type="number" value={order.etsyOrderValue} onChange={(value) => updateField("etsyOrderValue", value)} />
            </div>
          </Panel>

          <Panel title="Customer & Item">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Customer Name" value={order.customerName} onChange={(value) => updateField("customerName", value)} />
              <Field label="Country" value={order.country} onChange={(value) => updateField("country", value)} />
              <label className={`${labelClass} sm:col-span-2`}>Address
                <textarea className={`${inputClass} min-h-24 resize-y`} rows="4" value={order.address} onChange={(event) => updateField("address", event.target.value)} />
              </label>
              <Field className="sm:col-span-2" label="Product Title" value={order.productTitle} onChange={(value) => updateField("productTitle", value)} />
              <Field label="SKU" value={order.sku} onChange={(value) => updateField("sku", value)} />
              <label className={labelClass}>VAT / IOSS Override
                <select className={inputClass} value={order.taxOverride} onChange={(event) => updateField("taxOverride", event.target.value)}>
                  <option value="auto">Auto by country</option>
                  <option value="none">No VAT/IOSS</option>
                  <option value="ioss">Etsy IOSS</option>
                  <option value="ukvat">Etsy UK VAT</option>
                </select>
              </label>
            </div>
          </Panel>

          {debugBlocks.length > 0 && (
            <Panel title="Parser Blocks">
              <pre className="max-h-52 overflow-auto rounded-lg bg-slate-100 p-3 text-xs text-slate-700">{debugBlocks.slice(0, 18).map((block) => `p${block.page} (${Math.round(block.x0)},${Math.round(block.y0)}) ${block.text}`).join("\n\n")}</pre>
            </Panel>
          )}

          <footer className="flex flex-col gap-2 pb-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <p className="inline-flex items-center gap-2"><ShieldCheck size={15} className="text-owleaf" /> Your data is private. We do not store your files.</p>
            <p className="inline-flex items-center gap-1">Made with <Heart size={14} className="fill-red-500 text-red-500" /> by Owleaf</p>
          </footer>
        </section>

        <TemplatePdfPreview previewUrl={previewUrl} isLoading={loading.preview} />
      </div>
    </main>
  );
}

function Panel({ title, action, children }) {
  return (
    <section className={cardClass}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-extrabold text-slate-950">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, onChange, type = "text", className = "" }) {
  return (
    <label className={`${labelClass} ${className}`}>{label}
      <input className={inputClass} type={type} step={type === "number" ? "0.01" : undefined} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TemplatePdfPreview({ previewUrl, isLoading }) {
  return (
    <section className="relative min-w-0 rounded-xl border border-slate-200 bg-white/80 p-3 shadow-lg shadow-slate-300/40 backdrop-blur lg:sticky lg:top-8 lg:max-h-[calc(100vh-4rem)] lg:overflow-auto">
      {isLoading && (
        <div className="sticky top-3 z-10 mx-auto mb-3 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-4 py-2 text-sm font-bold text-owleaf shadow">
          <Spinner /> Updating preview
        </div>
      )}
      {previewUrl ? (
        <img className="mx-auto block h-auto w-full max-w-[794px] rounded-md bg-white shadow-sm" alt="Generated Canva-template invoice preview" src={previewUrl} />
      ) : (
        <div className="grid min-h-80 place-items-center rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
          <div>
            <h2 className="text-xl font-black text-slate-950">Template PDF Preview</h2>
            <p className="mt-2 max-w-sm text-sm leading-6 text-slate-600">Upload an Etsy PDF to generate a preview from the Canva template.</p>
          </div>
        </div>
      )}
    </section>
  );
}

function Spinner() {
  return <span className="inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function invoiceFileName(order) {
  const customer = safeFilePart(order.customerName || "Customer");
  const invoice = safeFilePart(order.invoiceNo || "Invoice");
  return `${customer} ${invoice}`.trim();
}

function safeFilePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function getTaxMode(order) {
  if (order.taxOverride !== "auto") return order.taxOverride;
  const country = String(order.country || "").trim().toLowerCase();
  if (["united kingdom", "uk", "great britain"].includes(country)) return "ukvat";
  if (EU_IOSS_COUNTRIES.has(country)) return "ioss";
  return "none";
}

createRoot(document.getElementById("root")).render(<App />);
