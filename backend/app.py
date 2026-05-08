from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Any

import fitz
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.responses import FileResponse
from starlette.staticfiles import StaticFiles


EU_IOSS_COUNTRIES = {
    "austria", "belgium", "bulgaria", "croatia", "cyprus", "czech republic",
    "czechia", "denmark", "estonia", "finland", "france", "germany",
    "greece", "hungary", "ireland", "italy", "latvia", "lithuania",
    "luxembourg", "malta", "netherlands", "poland", "portugal", "romania",
    "slovakia", "slovenia", "spain", "sweden",
}

COUNTRIES = [
    "United States", "United Kingdom", "France", "Germany", "Italy", "Spain",
    "Canada", "Australia", "Netherlands", "Sweden", "Ireland", "Belgium",
    "Austria", "Denmark", "Portugal", "Poland", "Norway", "Switzerland",
]

CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP"}
DISPLAY_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "AUD": "A$", "CAD": "C$", "INR": "₹"}
TAX_IDS = {
    "ioss": "Etsy's IOSS: IM3720000224",
    "ukvat": "Etsy's UK VAT: 370 6004 28",
}
TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "assets" / "invoice-template.pdf"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = PROJECT_ROOT / "dist"
FONT_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"
OPEN_SANS_REGULAR = FONT_DIR / "OpenSans-Regular.ttf"
OPEN_SANS_BOLD = FONT_DIR / "OpenSans-Bold.ttf"
OPEN_SANS_FONT = fitz.Font(fontfile=str(OPEN_SANS_REGULAR))
OPEN_SANS_BOLD_FONT = fitz.Font(fontfile=str(OPEN_SANS_BOLD))
GENERATED_PDFS: dict[str, bytes] = {}

app = FastAPI(title="Owleaf Invoice API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:4173", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if (DIST_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="frontend-assets")


@dataclass
class Block:
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str

    @property
    def lines(self) -> list[str]:
        return [line.strip() for line in self.text.splitlines() if line.strip()]


class InvoiceOrder(BaseModel):
    invoiceNo: str = ""
    invoiceDate: str = ""
    orderNumber: str = ""
    customerName: str = ""
    address: str = ""
    country: str = ""
    productTitle: str = ""
    sku: str = ""
    quantity: int | float | str = 1
    unitPrice: float | str = 0
    subtotalExTax: float | str = 0
    etsyOrderValue: float | str = 0
    invoiceValue: float | str = 0
    currency: str = "USD"
    taxOverride: str = "auto"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/parse-pdf")
async def parse_pdf(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read()
    blocks = extract_blocks(data)
    parsed = parse_etsy_blocks(blocks)
    return {
        "order": parsed,
        "debug": {
            "filename": file.filename,
            "blocks": [block.__dict__ for block in blocks],
        },
    }


@app.post("/api/generate-invoice")
async def generate_invoice(order: InvoiceOrder) -> Response:
    pdf_bytes = render_invoice_pdf(order)
    filename = f"invoice-{order.orderNumber or order.invoiceNo or 'etsy'}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/preview-invoice")
async def preview_invoice(order: InvoiceOrder) -> dict[str, str]:
    preview_id = uuid.uuid4().hex
    GENERATED_PDFS[preview_id] = render_invoice_pdf(order)
    return {
        "pdfUrl": f"/api/preview-invoice/{preview_id}.pdf",
        "imageUrl": f"/api/preview-invoice/{preview_id}.png",
    }


@app.get("/api/preview-invoice/{preview_id}.pdf")
async def get_preview_invoice(preview_id: str) -> Response:
    pdf_bytes = GENERATED_PDFS.get(preview_id)
    if not pdf_bytes:
        return Response(status_code=404, content="Preview expired")
    return Response(content=pdf_bytes, media_type="application/pdf")


@app.get("/api/preview-invoice/{preview_id}.png")
async def get_preview_invoice_image(preview_id: str) -> Response:
    pdf_bytes = GENERATED_PDFS.get(preview_id)
    if not pdf_bytes:
        return Response(status_code=404, content="Preview expired")
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pixmap = doc[0].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    image_bytes = pixmap.tobytes("png")
    doc.close()
    return Response(content=image_bytes, media_type="image/png")


@app.get("/{path:path}")
async def serve_frontend(path: str) -> FileResponse:
    requested = DIST_DIR / path
    if path and requested.is_file():
        return FileResponse(requested)
    return FileResponse(DIST_DIR / "index.html")


def render_invoice_pdf(order: InvoiceOrder) -> bytes:
    doc = fitz.open(TEMPLATE_PATH)
    page = doc[0]
    tax_mode = invoice_tax_mode(order.country, order.taxOverride)
    invoice_value = as_float(order.invoiceValue)
    if not invoice_value:
        invoice_value = as_float(order.subtotalExTax) if tax_mode == "none" else as_float(order.etsyOrderValue)
    quantity = max(as_float(order.quantity), 1)
    unit_value = invoice_value / quantity
    symbol = DISPLAY_SYMBOLS.get(order.currency, "")
    money = lambda value: f"{symbol}{as_float(value):.2f}"

    # Clear only the placeholder zones from the Canva PDF, then write dynamic values.
    clear_rect(page, (318, 142, 537, 162))
    draw_right_text(page, 536, 156, f"Invoice No. {order.invoiceNo}", size=11)
    clear_rect(page, (451, 160, 537, 178))
    draw_right_text(page, 536, 172, display_date(order.invoiceDate), size=11)

    clear_rect(page, (58, 201, 260, 260))
    draw_multiline(page, 59, 190, [order.customerName, *order.address.splitlines(), order.country], size=12.8, bold_first=True, line_gap=15.3)

    clear_rect(page, (58, 341, 270, 392))
    draw_wrapped_lines(page, 61, 353, order.productTitle, max_width=215, size=11.5, max_lines=2)
    draw_text(page, 61, 384, f"SKU: {order.sku}", size=8.6, color=(0.22, 0.22, 0.22))
    page.draw_line((61, 392), (536, 392), color=(0.12, 0.12, 0.12), width=0.6)

    clear_rect(page, (295, 338, 374, 374))
    clear_rect(page, (362, 338, 440, 376))
    clear_rect(page, (430, 338, 518, 361))
    draw_center_text(page, 302, 365, str(int(quantity) if quantity.is_integer() else quantity), size=12)
    draw_center_text(page, 394, 365, money(unit_value), size=12)
    draw_right_text(page, 536, 365, money(invoice_value), size=12, bold=True)

    clear_rect(page, (430, 403, 518, 424))
    clear_rect(page, (430, 437, 538, 474), fill=(0.1, 0.1, 0.1))
    draw_right_text(page, 536, 417, money(invoice_value), size=12, bold=True)
    draw_right_text(page, 536, 458, money(invoice_value), size=17, bold=True, color=(1, 1, 1))

    # The template has placeholders for order/country but not for VAT/IOSS. Redraw this
    # compact info group so UK VAT / EU IOSS can be inserted when required.
    clear_rect(page, (58, 642, 300, 737))
    info_lines = [
        "Order #: " + order.orderNumber,
        "IEC Code: AAHFO4998A",
    ]
    if TAX_IDS.get(tax_mode):
        info_lines.append(TAX_IDS[tax_mode])
    info_lines.extend([
        "GSTIN: 05AAHFO4998A1Z6",
        "Country of Origin: India",
        "Country of Destination: " + order.country,
        "Payment Terms: Prepaid",
    ])
    for index, line in enumerate(info_lines):
        draw_text(page, 59, 654 + index * 13.2, line, size=10.3)

    output = BytesIO()
    doc.save(output, garbage=4, deflate=True)
    doc.close()
    return output.getvalue()


def clear_rect(
    page: fitz.Page,
    rect: tuple[float, float, float, float],
    *,
    fill: tuple[float, float, float] = (1, 1, 1),
) -> None:
    page.draw_rect(fitz.Rect(rect), color=fill, fill=fill, overlay=True)


def draw_text(
    page: fitz.Page,
    x: float,
    y: float,
    text: str,
    *,
    size: float,
    bold: bool = False,
    color: tuple[float, float, float] = (0.12, 0.12, 0.12),
) -> None:
    text = clean_overlay_text(text).replace("\n", " ")
    if text:
        page.insert_text(
            (x, y),
            text,
            fontsize=size,
            fontname="OpenSansBold" if bold else "OpenSans",
            fontfile=str(OPEN_SANS_BOLD if bold else OPEN_SANS_REGULAR),
            color=color,
        )


def draw_right_text(
    page: fitz.Page,
    right_x: float,
    y: float,
    text: str,
    *,
    size: float,
    bold: bool = False,
    color: tuple[float, float, float] = (0.12, 0.12, 0.12),
) -> None:
    text = clean_overlay_text(text).replace("\n", " ")
    if not text:
        return
    width = text_width(text, size=size, bold=bold)
    draw_text(page, right_x - width, y, text, size=size, bold=bold, color=color)


def draw_center_text(
    page: fitz.Page,
    center_x: float,
    y: float,
    text: str,
    *,
    size: float,
    bold: bool = False,
    color: tuple[float, float, float] = (0.12, 0.12, 0.12),
) -> None:
    text = clean_overlay_text(text).replace("\n", " ")
    if not text:
        return
    width = text_width(text, size=size, bold=bold)
    draw_text(page, center_x - width / 2, y, text, size=size, bold=bold, color=color)


def draw_multiline(
    page: fitz.Page,
    x: float,
    y: float,
    lines: list[str],
    *,
    size: float,
    bold_first: bool = False,
    line_gap: float = 14,
    color: tuple[float, float, float] = (0.12, 0.12, 0.12),
) -> None:
    clean_lines = [clean_overlay_text(line).replace("\n", " ") for line in lines if clean_overlay_text(line)]
    for index, line in enumerate(clean_lines):
        draw_text(page, x, y + index * line_gap, line, size=size, bold=bold_first and index == 0, color=color)


def draw_wrapped_lines(
    page: fitz.Page,
    x: float,
    y: float,
    text: str,
    *,
    max_width: float,
    size: float,
    max_lines: int,
    bold: bool = False,
    color: tuple[float, float, float] = (0.12, 0.12, 0.12),
) -> None:
    words = clean_overlay_text(text).replace("\n", " ").split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if text_width(candidate, size=size, bold=bold) <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
            if len(lines) == max_lines:
                break
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) == max_lines and len(" ".join(lines).split()) < len(words):
        while text_width(lines[-1] + "...", size=size, bold=bold) > max_width and " " in lines[-1]:
            lines[-1] = lines[-1].rsplit(" ", 1)[0]
        lines[-1] = lines[-1].rstrip("., ") + "..."
    for index, line in enumerate(lines[:max_lines]):
        draw_text(page, x, y + index * (size + 3), line, size=size, bold=bold, color=color)


def text_width(text: str, *, size: float, bold: bool = False) -> float:
    font = OPEN_SANS_BOLD_FONT if bold else OPEN_SANS_FONT
    return font.text_length(text, fontsize=size)


def draw_textbox(
    page: fitz.Page,
    rect: tuple[float, float, float, float],
    text: str,
    *,
    size: float,
    bold: bool = False,
    color: tuple[float, float, float] = (0.12, 0.12, 0.12),
    align: int = fitz.TEXT_ALIGN_LEFT,
    bold_first: bool = False,
) -> None:
    text = clean_overlay_text(text)
    if not text:
        return
    box = fitz.Rect(rect)
    if bold_first and "\n" in text:
        first, rest = text.split("\n", 1)
        page.insert_textbox(
            box,
            first,
            fontsize=size,
            fontname="OpenSansBold",
            fontfile=str(OPEN_SANS_BOLD),
            color=color,
            align=align,
        )
        rest_box = fitz.Rect(box.x0, box.y0 + size + 3, box.x1, box.y1)
        page.insert_textbox(
            rest_box,
            rest,
            fontsize=size,
            fontname="OpenSans",
            fontfile=str(OPEN_SANS_REGULAR),
            color=color,
            align=align,
            lineheight=1.15,
        )
        return
    page.insert_textbox(
        box,
        text,
        fontsize=size,
        fontname="OpenSansBold" if bold else "OpenSans",
        fontfile=str(OPEN_SANS_BOLD if bold else OPEN_SANS_REGULAR),
        color=color,
        align=align,
        lineheight=1.15,
    )


def clean_overlay_text(value: Any) -> str:
    return re.sub(r"\n{3,}", "\n\n", str(value or "").strip())


def display_date(value: str) -> str:
    if not value:
        return ""
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%-d %B %Y")
    except ValueError:
        try:
            return datetime.strptime(value, "%Y-%m-%d").strftime("%#d %B %Y")
        except ValueError:
            return value


def as_float(value: Any) -> float:
    try:
        return float(str(value).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def invoice_tax_mode(country: str, override: str) -> str:
    if override != "auto":
        return override
    return infer_tax_mode(country)


def extract_blocks(data: bytes) -> list[Block]:
    doc = fitz.open(stream=BytesIO(data), filetype="pdf")
    blocks: list[Block] = []
    for page_index, page in enumerate(doc):
        for raw in page.get_text("blocks"):
            text = normalize_text(raw[4])
            if not text:
                continue
            blocks.append(Block(page_index + 1, raw[0], raw[1], raw[2], raw[3], text))
    return sorted(blocks, key=lambda item: (item.page, item.y0, item.x0))


def normalize_text(value: str) -> str:
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.replace("\xa0", " ").splitlines()]
    return "\n".join(line for line in lines if line)


def parse_etsy_blocks(blocks: list[Block]) -> dict[str, Any]:
    all_text = "\n".join(block.text for block in blocks)
    ship_block = first_block(blocks, r"^(Ship to|Deliver to)\b")
    address = parse_address_block(ship_block)
    country = address["country"] or parse_country(all_text)
    totals = parse_customer_currency_totals(blocks)
    order_number = regex_value(all_text, r"Order\s*#?\s*(\d{6,})")
    order_date = parse_date(regex_value(all_text, r"Order date\s*([\d]{1,2}\s+[A-Za-z]+,?\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})"))
    sku = regex_value(all_text, r"SKU:\s*([A-Z0-9][A-Z0-9_-]+)")
    quantity = parse_quantity(blocks) or 1
    title = parse_title(blocks, sku)
    tax_mode = infer_tax_mode(country)
    invoice_value = totals["order_total"] if tax_mode in {"ioss", "ukvat"} else totals["subtotal"]
    if not invoice_value:
        invoice_value = totals["order_total"] or totals["item_total"]

    return {
        "invoiceNo": f"OWL{order_number[-6:]}" if order_number else "",
        "invoiceDate": order_date,
        "orderNumber": order_number,
        "customerName": address["customer_name"],
        "address": "\n".join(address["address_lines"]),
        "country": country,
        "productTitle": title,
        "sku": sku,
        "quantity": quantity,
        "unitPrice": round(invoice_value / quantity, 2) if quantity else invoice_value,
        "subtotalExTax": totals["subtotal"],
        "etsyOrderValue": totals["order_total"],
        "invoiceValue": invoice_value,
        "currency": totals["currency"] or currency_from_country(country),
        "taxOverride": "auto",
        "taxMode": tax_mode,
        "confidence": confidence_score(address, title, sku, order_number, invoice_value),
    }


def first_block(blocks: list[Block], pattern: str) -> Block | None:
    compiled = re.compile(pattern, re.IGNORECASE)
    return next((block for block in blocks if compiled.search(block.text)), None)


def parse_address_block(block: Block | None) -> dict[str, Any]:
    if not block:
        return {"customer_name": "", "address_lines": [], "country": ""}
    lines = block.lines
    if lines and re.match(r"^(Ship to|Deliver to)$", lines[0], re.IGNORECASE):
        lines = lines[1:]
    country = lines[-1] if lines and is_country(lines[-1]) else ""
    body = lines[:-1] if country else lines
    return {
        "customer_name": body[0] if body else "",
        "address_lines": body[1:] if len(body) > 1 else [],
        "country": country,
    }


def parse_country(text: str) -> str:
    for country in COUNTRIES:
        if re.search(rf"\b{re.escape(country)}\b", text, re.IGNORECASE):
            return country
    return ""


def is_country(value: str) -> bool:
    normalized = value.strip().lower()
    return any(normalized == country.lower() for country in COUNTRIES)


def parse_customer_currency_totals(blocks: list[Block]) -> dict[str, Any]:
    totals = {"currency": "", "item_total": 0.0, "subtotal": 0.0, "tax": 0.0, "order_total": 0.0}
    customer_blocks = [block for block in blocks if "INR" not in block.text and block.x0 > 350]
    for block in customer_blocks:
        lines = block.lines
        if len(lines) < 2:
            continue
        label = lines[0].lower()
        amount, currency = parse_money(lines[-1])
        if currency and not totals["currency"]:
            totals["currency"] = currency
        if "item total" in label:
            totals["item_total"] = amount
        elif "subtotal" in label:
            totals["subtotal"] = amount
        elif label == "tax":
            totals["tax"] = amount
        elif "order total" in label:
            totals["order_total"] = amount
    return totals


def parse_money(value: str) -> tuple[float, str]:
    currency = ""
    for symbol, code in CURRENCY_SYMBOLS.items():
        if symbol in value:
            currency = code
            break
    code_match = re.search(r"\b(USD|EUR|GBP|AUD|CAD)\b", value, re.IGNORECASE)
    if code_match:
        currency = code_match.group(1).upper()
    number_match = re.search(r"(-?\s*)?([0-9][0-9,]*(?:\.[0-9]{2})?)", value)
    if not number_match:
        return 0.0, currency
    amount = float(number_match.group(0).replace(" ", "").replace(",", ""))
    return amount, currency


def parse_quantity(blocks: list[Block]) -> int:
    for block in blocks:
        if block.x0 > 450:
            match = re.search(r"\b(\d+)\s*x\s*", block.text)
            if match:
                return int(match.group(1))
    match = re.search(r"\b(\d+)\s+item\b", "\n".join(block.text for block in blocks), re.IGNORECASE)
    return int(match.group(1)) if match else 0


def parse_title(blocks: list[Block], sku: str) -> str:
    sku_block = next((block for block in blocks if sku and sku in block.text), None)
    if sku_block:
        candidates = [
            block for block in blocks
            if block.page == sku_block.page
            and 150 <= block.x0 < 450
            and 90 <= block.y0 < sku_block.y0
            and not re.search(r"\bitem\b|INR|USD|EUR|GBP|\$|€|£|\d+\s*x\s*", block.text, re.IGNORECASE)
        ]
        if candidates:
            return candidates[-1].text.replace("\n", " ").strip()
    fallback = [
        block for block in blocks
        if block.x0 >= 150 and 90 <= block.y0 <= 180 and not re.search(r"\bitem\b|INR|\$|€|£", block.text, re.IGNORECASE)
    ]
    return fallback[0].text.replace("\n", " ").strip() if fallback else ""


def regex_value(text: str, pattern: str) -> str:
    match = re.search(pattern, text, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def parse_date(value: str) -> str:
    value = value.replace(",", "").strip()
    for fmt in ("%d %B %Y", "%d %b %Y", "%B %d %Y", "%b %d %Y"):
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ""


def infer_tax_mode(country: str) -> str:
    normalized = country.lower().strip()
    if normalized in {"united kingdom", "uk", "great britain"}:
        return "ukvat"
    if normalized in EU_IOSS_COUNTRIES:
        return "ioss"
    return "none"


def currency_from_country(country: str) -> str:
    normalized = country.lower().strip()
    if normalized in {"united kingdom", "uk", "great britain"}:
        return "GBP"
    if normalized in EU_IOSS_COUNTRIES:
        return "EUR"
    return "USD"


def confidence_score(address: dict[str, Any], title: str, sku: str, order_number: str, invoice_value: float) -> int:
    checks = [
        bool(address["customer_name"]),
        bool(address["address_lines"]),
        bool(address["country"]),
        bool(title),
        bool(sku),
        bool(order_number),
        bool(invoice_value),
    ]
    return round(sum(checks) / len(checks) * 100)
