import path from 'node:path';

const collectionConstructors = ['Map', 'Set', 'WeakMap', 'WeakSet'];

const functionTypes = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'];

const relativePath = (context) =>
  path.relative(context.cwd, context.filename).split(path.sep).join('/');

const allowedFiles = (context) => {
  const options = context.options[0];
  if (options === undefined || !Array.isArray(options.allow)) {
    return [];
  }
  return options.allow.filter((entry) => typeof entry === 'string');
};

const isModuleLevel = (declaration) => {
  const parent = declaration.parent;
  if (parent.type === 'Program') {
    return true;
  }
  return parent.type === 'ExportNamedDeclaration' && parent.parent.type === 'Program';
};

const collectionScope = (node) => {
  let child = node;
  let ancestor = node.parent;
  while (ancestor !== null && ancestor !== undefined) {
    if (functionTypes.includes(ancestor.type)) {
      return null;
    }
    if (
      (ancestor.type === 'PropertyDefinition' || ancestor.type === 'AccessorProperty') &&
      ancestor.value === child
    ) {
      return 'classField';
    }
    if (ancestor.type === 'Program') {
      return 'moduleCollection';
    }
    child = ancestor;
    ancestor = ancestor.parent;
  }
  return null;
};

const noModuleState = {
  meta: {
    docs: { description: 'Forbid module level mutable state and in-memory caches' },
    messages: {
      moduleLet: "Module level '{{kind}}' keeps state between requests; it is not allowed.",
      moduleCollection: "Module level 'new {{name}}' is an in-memory cache; it is not allowed.",
      classField: "Class field 'new {{name}}' is an in-memory cache; it is not allowed.",
    },
    schema: [
      {
        properties: { allow: { items: { minLength: 1 }, uniqueItems: true } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (allowedFiles(context).includes(relativePath(context))) {
      return {};
    }
    return {
      VariableDeclaration(node) {
        if ((node.kind === 'let' || node.kind === 'var') && isModuleLevel(node)) {
          context.report({ node, messageId: 'moduleLet', data: { kind: node.kind } });
        }
      },
      NewExpression(node) {
        if (
          node.callee.type !== 'Identifier' ||
          !collectionConstructors.includes(node.callee.name)
        ) {
          return;
        }
        const messageId = collectionScope(node);
        if (messageId !== null) {
          context.report({ node, messageId, data: { name: node.callee.name } });
        }
      },
    };
  },
};

export default noModuleState;
