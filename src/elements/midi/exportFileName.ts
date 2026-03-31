function padTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

export function buildDruminkExportBaseName(date = new Date()): string {
  const year = date.getFullYear();
  const month = padTwoDigits(date.getMonth() + 1);
  const day = padTwoDigits(date.getDate());
  const hours = padTwoDigits(date.getHours());
  const minutes = padTwoDigits(date.getMinutes());
  const seconds = padTwoDigits(date.getSeconds());

  return `druminkbeat_${year}-${month}-${day}_${hours}${minutes}${seconds}`;
}
