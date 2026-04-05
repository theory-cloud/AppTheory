export function trimRepeatedCharStart(value: string, char: string): string {
  let start = 0;
  while (start < value.length && value[start] === char) {
    start += 1;
  }
  return start === 0 ? value : value.slice(start);
}

export function trimRepeatedCharEnd(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export function trimRepeatedChar(value: string, char: string): string {
  return trimRepeatedCharEnd(trimRepeatedCharStart(value, char), char);
}
