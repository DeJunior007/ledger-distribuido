import path from 'node:path';
import ts from 'typescript';

const moneyWords = ['amount', 'balance', 'money', 'stake', 'payout', 'price', 'difference', 'ggr'];

const moneyCallMembers = ['toFixed', 'toPrecision', 'setTypeParser'];

const strictConversionPrefixes = [
  'src/domain/',
  'src/application/',
  'src/infrastructure/persistence/',
];

const isUppercaseLetter = (character) =>
  character !== character.toLowerCase() && character === character.toUpperCase();

const isMoneyName = (name) => {
  const lowerName = name.toLowerCase();
  return moneyWords.some((word) => {
    if (!lowerName.endsWith(word)) {
      return false;
    }
    const start = name.length - word.length;
    if (start === 0) {
      return true;
    }
    return name.charAt(start - 1) === '_' || isUppercaseLetter(name.charAt(start));
  });
};

const isNumberLike = (type) => {
  if (type.isUnion() || type.isIntersection()) {
    return type.types.some(isNumberLike);
  }
  return (type.flags & ts.TypeFlags.NumberLike) !== 0;
};

const returnsNumber = (type) =>
  type.getCallSignatures().some((signature) => isNumberLike(signature.getReturnType()));

const relativePath = (context) =>
  path.relative(context.cwd, context.filename).split(path.sep).join('/');

const memberName = (member) => {
  if (!member.computed && member.property.type === 'Identifier') {
    return member.property.name;
  }
  if (member.property.type === 'Literal' && typeof member.property.value === 'string') {
    return member.property.value;
  }
  return null;
};

const objectName = (member) => (member.object.type === 'Identifier' ? member.object.name : null);

const bindingIdentifiers = (pattern) => {
  if (pattern === null) {
    return [];
  }
  switch (pattern.type) {
    case 'Identifier':
      return [pattern];
    case 'AssignmentPattern':
      return bindingIdentifiers(pattern.left);
    case 'RestElement':
      return bindingIdentifiers(pattern.argument);
    case 'TSParameterProperty':
      return bindingIdentifiers(pattern.parameter);
    case 'ArrayPattern':
      return pattern.elements.flatMap(bindingIdentifiers);
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        property.type === 'RestElement'
          ? bindingIdentifiers(property)
          : bindingIdentifiers(property.value),
      );
    default:
      return [];
  }
};

const moneyNoNumber = {
  meta: {
    docs: { description: 'Forbid number for money values and number conversions of money' },
    messages: {
      numberMoney: "'{{name}}' holds money and must use Money instead of number.",
      numberMoneyReturn: "'{{name}}' returns money and must return Money instead of number.",
      forbiddenCall: "'{{callee}}' is not allowed in src; money is handled only by Money.",
      forbiddenConversion:
        "'{{callee}}' is not allowed in this layer; money is handled only by Money.",
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (services?.program === undefined || services.program === null) {
      throw new TypeError('jungle/money-no-number requires type information.');
    }
    const filePath = relativePath(context);
    const inSrc = filePath.startsWith('src/');
    const strictConversion = strictConversionPrefixes.some((prefix) => filePath.startsWith(prefix));

    const checkNamed = (nameNode) => {
      if (nameNode.type !== 'Identifier' || !isMoneyName(nameNode.name)) {
        return;
      }
      const type = services.getTypeAtLocation(nameNode);
      if (isNumberLike(type)) {
        context.report({ node: nameNode, messageId: 'numberMoney', data: { name: nameNode.name } });
        return;
      }
      if (returnsNumber(type)) {
        context.report({
          node: nameNode,
          messageId: 'numberMoneyReturn',
          data: { name: nameNode.name },
        });
      }
    };

    const checkKey = (node) => {
      if (!node.computed) {
        checkNamed(node.key);
      }
    };

    const checkParams = (node) => {
      for (const identifier of node.params.flatMap(bindingIdentifiers)) {
        checkNamed(identifier);
      }
    };

    const checkFunctionName = (node) => {
      if (node.id !== null) {
        checkNamed(node.id);
      }
    };

    const reportCall = (node, callee, messageId) => {
      context.report({ node, messageId, data: { callee } });
    };

    const checkCall = (node) => {
      if (!inSrc) {
        return;
      }
      const callee = node.callee;
      if (callee.type === 'Identifier') {
        if (callee.name === 'parseFloat') {
          reportCall(node, 'parseFloat', 'forbiddenCall');
        } else if (strictConversion && (callee.name === 'Number' || callee.name === 'parseInt')) {
          reportCall(node, callee.name, 'forbiddenConversion');
        }
        return;
      }
      if (callee.type !== 'MemberExpression') {
        return;
      }
      const name = memberName(callee);
      const owner = objectName(callee);
      if (name === null) {
        return;
      }
      if (moneyCallMembers.includes(name)) {
        reportCall(node, `.${name}`, 'forbiddenCall');
      } else if (owner === 'Math' && name === 'round') {
        reportCall(node, 'Math.round', 'forbiddenCall');
      } else if (owner === 'Number' && name === 'parseFloat') {
        reportCall(node, 'Number.parseFloat', 'forbiddenCall');
      } else if (strictConversion && owner === 'Number' && name === 'parseInt') {
        reportCall(node, 'Number.parseInt', 'forbiddenConversion');
      }
    };

    return {
      VariableDeclarator(node) {
        for (const identifier of bindingIdentifiers(node.id)) {
          checkNamed(identifier);
        }
      },
      FunctionDeclaration(node) {
        checkFunctionName(node);
        checkParams(node);
      },
      TSDeclareFunction(node) {
        checkFunctionName(node);
        checkParams(node);
      },
      FunctionExpression: checkParams,
      ArrowFunctionExpression: checkParams,
      TSEmptyBodyFunctionExpression: checkParams,
      TSMethodSignature(node) {
        checkKey(node);
        checkParams(node);
      },
      MethodDefinition: checkKey,
      TSAbstractMethodDefinition: checkKey,
      PropertyDefinition: checkKey,
      TSAbstractPropertyDefinition: checkKey,
      TSPropertySignature: checkKey,
      Property(node) {
        if (node.parent.type === 'ObjectExpression') {
          checkKey(node);
        }
      },
      CallExpression: checkCall,
    };
  },
};

export default moneyNoNumber;
