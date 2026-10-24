const noComments = {
  meta: {
    docs: { description: 'Forbid every comment in source files' },
    messages: { comment: 'Comments are not allowed.' },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === 'Shebang') {
            continue;
          }
          context.report({ loc: comment.loc, messageId: 'comment' });
        }
      },
    };
  },
};

export default noComments;
