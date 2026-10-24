import path from 'node:path';

const routeDecorators = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

const accessDecorators = ['Roles', 'Public'];

const publicControllers = ['health.controller.ts', 'metrics.controller.ts'];

const decoratorName = (decorator) => {
  const expression =
    decorator.expression.type === 'CallExpression'
      ? decorator.expression.callee
      : decorator.expression;
  if (expression.type === 'Identifier') {
    return expression.name;
  }
  if (expression.type === 'MemberExpression' && expression.property.type === 'Identifier') {
    return expression.property.name;
  }
  return null;
};

const controllerAccess = {
  meta: {
    docs: { description: 'Require @Roles or @Public on every controller route handler' },
    messages: {
      missingAccess: "Route handler '{{name}}' needs @Roles(...) or @Public().",
      publicNotAllowed:
        '@Public() is allowed only in health.controller.ts and metrics.controller.ts.',
    },
    schema: [],
  },
  create(context) {
    const publicAllowed = publicControllers.includes(path.basename(context.filename));
    return {
      Decorator(node) {
        if (!publicAllowed && decoratorName(node) === 'Public') {
          context.report({ node, messageId: 'publicNotAllowed' });
        }
      },
      MethodDefinition(node) {
        const names = (node.decorators ?? []).map(decoratorName);
        const isRoute = names.some((name) => routeDecorators.includes(name));
        const hasAccess = names.some((name) => accessDecorators.includes(name));
        if (isRoute && !hasAccess) {
          const name = node.key.type === 'Identifier' ? node.key.name : 'handler';
          context.report({ node: node.key, messageId: 'missingAccess', data: { name } });
        }
      },
    };
  },
};

export default controllerAccess;
