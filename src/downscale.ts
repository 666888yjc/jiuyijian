const MAX_EDGE = 1800;
const TARGET_BYTES = 680 * 1024;

/** 将图片文件缩放压缩为识别用的 JPEG base64（原件不动，仅本机处理） */
export async function fileToExtractImage(file: File): Promise<{ base64: string; mediaType: "image/jpeg"; bytes: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes <= TARGET_BYTES) {
      return { base64, mediaType: "image/jpeg", bytes };
    }
  }
  throw new Error("image_too_complex");
}
