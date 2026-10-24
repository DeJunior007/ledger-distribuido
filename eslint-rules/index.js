import controllerAccess from './controller-access.js';
import moneyNoNumber from './money-no-number.js';
import noComments from './no-comments.js';
import noModuleState from './no-module-state.js';

const jungle = {
  meta: { name: 'jungle' },
  rules: {
    'no-comments': noComments,
    'money-no-number': moneyNoNumber,
    'no-module-state': noModuleState,
    'controller-access': controllerAccess,
  },
};

export default jungle;
