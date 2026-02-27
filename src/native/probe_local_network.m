/**
 * Native N-API addon that triggers macOS Local Network TCC prompt.
 *
 * Node.js POSIX sockets don't trigger the prompt — only Apple's Network
 * framework APIs do. This addon creates an NWBrowser for Bonjour service
 * discovery, which runs inside the Electron process and triggers the
 * system permission dialog.
 *
 * Exports: probe(serviceType) → undefined
 *   serviceType: Bonjour service type string, e.g. "_blackmagic._tcp"
 */
#include <node_api.h>
#import <Network/Network.h>

static nw_browser_t active_browser = nil;

static napi_value Probe(napi_env env, napi_callback_info info) {
    // Clean up any previous browser
    if (active_browser) {
        nw_browser_cancel(active_browser);
        active_browser = nil;
    }

    // Get service type argument (default: "_blackmagic._tcp")
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

    char service_type[128] = "_blackmagic._tcp";
    if (argc > 0) {
        napi_valuetype type;
        napi_typeof(env, argv[0], &type);
        if (type == napi_string) {
            size_t len;
            napi_get_value_string_utf8(env, argv[0], service_type, sizeof(service_type), &len);
        }
    }

    // Create Bonjour browser — this triggers the Local Network TCC prompt
    nw_browse_descriptor_t descriptor =
        nw_browse_descriptor_create_bonjour_service(service_type, "local.");
    nw_parameters_t params = nw_parameters_create();

    active_browser = nw_browser_create(descriptor, params);
    nw_browser_set_queue(active_browser, dispatch_get_main_queue());

    nw_browser_set_browse_results_changed_handler(active_browser,
        ^(nw_browse_result_t old_result, nw_browse_result_t new_result, bool batch_complete) {
            // No-op — we only need the browser to start to trigger the prompt
        });

    nw_browser_start(active_browser);

    // Cancel after 3 seconds
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC),
        dispatch_get_main_queue(), ^{
            if (active_browser) {
                nw_browser_cancel(active_browser);
                active_browser = nil;
            }
        });

    napi_value undefined;
    napi_get_undefined(env, &undefined);
    return undefined;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;
    napi_create_function(env, "probe", NAPI_AUTO_LENGTH, Probe, NULL, &fn);
    napi_set_named_property(env, exports, "probe", fn);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
