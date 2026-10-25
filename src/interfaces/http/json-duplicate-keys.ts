type JsonScope = Set<unknown> | undefined;

const closingQuoteIndex = (text: string, openingQuote: number): number => {
  let index = openingQuote + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === '\\' ? 2 : 1;
  }
  return index;
};

export const hasDuplicateJsonKey = (text: string): boolean => {
  const scopes: JsonScope[] = [];
  let expectingKey = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = closingQuoteIndex(text, index);
      const scope = scopes.at(-1);
      if (expectingKey && scope !== undefined) {
        const key: unknown = JSON.parse(text.slice(index, end + 1));
        if (scope.has(key)) {
          return true;
        }
        scope.add(key);
      }
      expectingKey = false;
      index = end + 1;
      continue;
    }
    if (char === '{') {
      scopes.push(new Set());
      expectingKey = true;
    } else if (char === '[') {
      scopes.push(undefined);
      expectingKey = false;
    } else if (char === '}' || char === ']') {
      scopes.pop();
      expectingKey = false;
    } else if (char === ',') {
      expectingKey = scopes.at(-1) !== undefined;
    }
    index += 1;
  }
  return false;
};
