export default {
    // GJS's registerClass accepts (klass) or (metaInfo, klass).
    registerClass(a, b) {
        return b ?? a;
    },
    ParamSpec: {},
    Object: class GObjectObject {},
    signal_handler_is_connected() {
        return true;
    },
};
