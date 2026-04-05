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

export function collapseRepeatedChar(value: string, char: string): string {
  let out = "";
  let previousWasChar = false;
  for (const current of value) {
    const isChar = current === char;
    if (isChar && previousWasChar) {
      continue;
    }
    out += current;
    previousWasChar = isChar;
  }
  return out;
}

export function stripTrailingPort(value: string): string {
  let end = value.length;
  while (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code < 48 || code > 57) {
      break;
    }
    end -= 1;
  }
  if (end === value.length || end === 0 || value[end - 1] !== ":") {
    return value;
  }
  return value.slice(0, end - 1);
}
